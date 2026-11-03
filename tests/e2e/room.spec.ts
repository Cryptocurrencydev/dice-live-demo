import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

// Runs against a real deployment (BASE_URL): real LiveKit video, real Supabase engine.
// Two browser contexts = two people with Chrome's fake camera/mic.

const uid = () => Math.random().toString(36).slice(2, 7);

async function person(browser: Browser, info: TestInfo) {
  const ctx = await browser.newContext({ ...info.project.use, permissions: ["camera", "microphone"] });
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on("console", (m) => { if (m.type() === "error") errors.push(`[console] ${m.text()}`); });
    p.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  };
  ctx.on("page", watch);
  const page = await ctx.newPage();
  return { ctx, page, errors };
}

async function signIn(page: Page, name: string) {
  await page.getByLabel("Pick a street name").fill(name);
  await page.getByRole("button", { name: /Let's roll|Take a seat|Watch/ }).click();
}

const tile = (page: Page, name: string) => page.locator(`[data-testid=tile][data-player="${name}"]`);
const phase = (page: Page) => page.getByTestId("felt");
const openHistory = async (page: Page, mobile: boolean) => {
  if (mobile) await page.getByTestId("open-history").click();
  return mobile ? page.getByTestId("history-sheet").getByTestId("history") : page.locator("aside").getByTestId("history");
};
const closeSheet = (page: Page) => page.getByRole("button", { name: "Close" }).click();

async function videoPlaying(page: Page, name: string) {
  const v = tile(page, name).locator("video");
  await expect(v).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => v.evaluate((el: HTMLVideoElement) => el.videoWidth > 0 && el.readyState >= 2), { timeout: 30_000 }).toBe(true);
}

async function noSideScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}

async function startCls(page: Page) {
  await page.evaluate(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) {
        if (e.hadRecentInput) continue;
        (window as any).__cls += e.value;
        ((window as any).__clsSrc ??= []).push(`${e.value.toFixed(3)} ${(e.sources ?? []).map((s: any) => s.node?.className || s.node?.nodeName).join(" | ")}`);
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
}

let ctxs: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(ctxs.map((c) => c.close().catch(() => {}))); ctxs = []; });

test("two players: live video, bets, roll, catch, disconnect + rejoin", async ({ browser }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const A = await person(browser, info), B = await person(browser, info);
  ctxs.push(A.ctx, B.ctx);
  const an = `ann_${uid()}`, bn = `bo_${uid()}`;

  // A opens a table
  await A.page.goto("/");
  await signIn(A.page, an);
  await A.page.getByRole("button", { name: "Start an empty table" }).click();
  await A.page.waitForURL(/\/r\/[A-Z0-9]{5}$/);
  const url = A.page.url();
  const code = url.split("/r/")[1];
  await expect(A.page.getByTestId("room-code")).toHaveText(code);

  // B joins the same table from the link
  await B.page.goto(url);
  await signIn(B.page, bn);
  await expect(B.page.getByTestId("felt")).toBeVisible();
  await startCls(B.page);

  // both see both video tiles, with real frames from the fake camera
  for (const p of [A.page, B.page]) {
    await expect(p.locator("[data-testid=tile]")).toHaveCount(2);
    await videoPlaying(p, an);
    await videoPlaying(p, bn);
  }
  await expect(tile(A.page, an)).toHaveAttribute("data-shooter", "1");
  await noSideScroll(A.page); await noSideScroll(B.page);

  // B fades the shooter; A sees it on B's tile
  await expect(phase(B.page)).toHaveAttribute("data-phase", "betting");
  await B.page.getByTestId("side-against").click();
  await B.page.getByTestId("chip-50").click();
  await expect(tile(A.page, bn).getByTestId("tile-bet")).toHaveText("Fade 50");
  await expect(B.page.getByTestId("my-stake")).toContainText("Fade 50");

  // A rolls (server picks the faces); B calls catch inside the 5s window
  await A.page.getByTestId("roll").click();
  await expect(phase(B.page)).toHaveAttribute("data-phase", "catch_window", { timeout: 10_000 });
  await B.page.getByTestId("catch-cocked").click();
  // B is the only other seated player, so B's call is a majority: roll voided, shooter rerolls
  await expect(phase(A.page)).toHaveAttribute("data-phase", "reroll");
  const histA = await openHistory(A.page, mobile);
  await expect(histA).toContainText(`${bn} called CATCH: cocked dice`);
  await expect(histA).toContainText("Catch upheld 1/1");
  if (mobile) await closeSheet(A.page);
  await expect(B.page.getByTestId("my-stake")).toContainText("🔒"); // stake stays locked through the reroll

  // reroll, and the server resolves the catch window on its own clock
  await A.page.getByTestId("roll").click();
  await expect(phase(A.page)).toHaveAttribute("data-phase", "catch_window");
  await expect(phase(A.page)).not.toHaveAttribute("data-phase", "catch_window", { timeout: 15_000 });
  const hist2 = await openHistory(A.page, mobile);
  await expect(hist2.locator("li[data-kind=roll]")).toHaveCount(2);
  if (mobile) await closeSheet(A.page);

  // B drops off: seat is held, A sees "away"
  const seatIndexBefore = await A.page.locator("[data-testid=video-grid] > *").evaluateAll(
    (els, n) => els.findIndex((e) => e.getAttribute("data-player") === n), bn);
  await B.page.close();
  await expect(tile(A.page, bn)).toHaveAttribute("data-status", "away", { timeout: 30_000 });
  await expect(tile(A.page, bn)).toContainText(/Away \d+s/);
  const coinsWhileAway = (await tile(A.page, bn).getByTestId("tile-coins").innerText()).replace(/\D/g, "");

  // B comes back to the same link inside 30s: same seat, same balance
  const B2 = await B.ctx.newPage();
  await B2.goto(url);
  await expect(tile(A.page, bn)).toHaveAttribute("data-status", "active", { timeout: 20_000 });
  const seatIndexAfter = await A.page.locator("[data-testid=video-grid] > *").evaluateAll(
    (els, n) => els.findIndex((e) => e.getAttribute("data-player") === n), bn);
  expect(seatIndexAfter).toBe(seatIndexBefore);
  await expect(B2.getByTestId("my-balance")).toHaveText(new RegExp(Number(coinsWhileAway).toLocaleString().replace(",", ",?")));
  await videoPlaying(A.page, bn);
  const histB = await openHistory(B2, mobile);
  await expect(histB).toContainText(`${bn} disconnected (seat held 30s)`);
  await expect(histB).toContainText(`${bn} reconnected`);

  // B's page held still while live state streamed in
  expect(A.errors, A.errors.join("\n")).toEqual([]);
  expect(B.errors, B.errors.join("\n")).toEqual([]);
});

test("solo with bots: full live table, bots bet/roll, QR codes, watch link", async ({ browser }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const S = await person(browser, info);
  ctxs.push(S.ctx);
  await S.page.goto("/");
  await signIn(S.page, `solo_${uid()}`);
  await S.page.getByRole("button", { name: "Start a table with bots" }).click();
  await S.page.waitForURL(/\/r\/[A-Z0-9]{5}\?bots=1$/);
  const code = S.page.url().match(/\/r\/([A-Z0-9]{5})/)![1];
  await expect(S.page.locator("[data-testid=tile][data-bot='1']")).toHaveCount(3);
  await noSideScroll(S.page);
  await startCls(S.page);

  // bots play through the server: within a few rolls the history shows bot bets and bot rolls
  const hist = await openHistory(S.page, mobile);
  await expect(hist).toContainText(/(Lucky|Slim|Dutch) (fades|backs) for \d+/, { timeout: 60_000 });
  if (mobile) await closeSheet(S.page);
  // keep shooting until the dice pass to a bot, then the bots roll on their own
  const botRolled = async () => {
    const h = await openHistory(S.page, mobile);
    const ok = /(Lucky|Slim|Dutch) rolled \d·\d/.test(await h.innerText());
    if (mobile) await closeSheet(S.page);
    return ok;
  };
  await expect.poll(async () => {
    const roll = S.page.getByTestId("roll");
    if (await roll.isVisible() && await roll.isEnabled()) await roll.click();
    return botRolled();
  }, { timeout: 100_000, intervals: [1500] }).toBe(true);

  // QR codes for the room link and the bots link
  if (mobile) await S.page.getByTestId("open-share").click();
  const shareScope = mobile ? S.page.getByTestId("share-sheet") : S.page.locator("aside");
  for (const id of ["qr-room", "qr-bots"]) {
    const img = shareScope.getByTestId(id).locator("img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  }
  if (mobile) await closeSheet(S.page);

  // spectator: no camera, no betting
  const W = await person(browser, info);
  ctxs.push(W.ctx);
  await W.page.goto(`/r/${code}?watch=1`);
  await signIn(W.page, `eye_${uid()}`);
  await expect(W.page.getByTestId("actions")).toContainText("You're watching");
  await expect(W.page.locator("[data-testid^=chip-]")).toHaveCount(0);
  await expect(W.page.getByTestId("toggle-cam")).toHaveCount(0);
  await expect(W.page.locator("[data-testid=tile]")).toHaveCount(4);
  await videoPlaying(W.page, await S.page.locator("[data-testid=tile][data-bot='0']").getAttribute("data-player") as string);

  // play limits: visible session timer
  await expect(S.page.getByTestId("session-timer")).toHaveText(/⏱ \d\d:\d\d/);

  const cls = await S.page.evaluate(() => (window as any).__cls as number);
  const src = await S.page.evaluate(() => ((window as any).__clsSrc ?? []).join("\n"));
  expect(cls, `CLS ${cls}\n${src}`).toBeLessThan(0.05);
  expect(S.errors, S.errors.join("\n")).toEqual([]);
  expect(W.errors, W.errors.join("\n")).toEqual([]);
});

test("play limits: daily cap is configurable and server-enforced; reminder shows on schedule", async ({ browser }, info) => {
  const P = await person(browser, info);
  ctxs.push(P.ctx);
  await P.page.goto("/");
  await signIn(P.page, `cap_${uid()}`);
  await P.page.getByRole("button", { name: "Start an empty table" }).click();
  await P.page.waitForURL(/\/r\/[A-Z0-9]{5}$/);
  const url = P.page.url();

  // set a 500 daily cap from the session timer
  await P.page.getByTestId("session-timer").click();
  await P.page.getByTestId("limits").getByRole("button", { name: "500", exact: true }).click();
  await expect(P.page.getByTestId("limits").getByRole("button", { name: "500", exact: true })).toHaveAttribute("aria-pressed", "true");
  await P.page.getByRole("button", { name: "Keep playing" }).click();

  // 250 + 250 reaches the cap; the server ledger shows it
  await P.page.getByTestId("chip-250").click();
  await expect(P.page.getByTestId("my-stake")).toContainText("Back 250");
  await P.page.getByTestId("chip-250").click();
  await expect(P.page.getByTestId("my-stake")).toContainText("Back 500");
  await expect(P.page.getByTestId("chip-25")).toBeDisabled();
  // crossing 80% of the cap pops the gentle reminder on its own
  await expect(P.page.getByTestId("limits-sheet")).toBeVisible();
  await expect(P.page.getByTestId("limits")).toContainText("500 / 500");
  await P.page.getByRole("button", { name: "Keep playing" }).click();

  // time-based reminder fires on schedule (?remind=30 shortens the 20-minute default for the demo)
  await P.page.goto(`${url}?remind=30`);
  const sheet = P.page.getByTestId("limits-sheet");
  await expect(sheet).toBeVisible();
  if (await P.page.getByTestId("limits").innerText().then((t) => /played \d+% of today/.test(t))) {
    await P.page.getByRole("button", { name: "Keep playing" }).click();
  }
  await expect(P.page.getByTestId("limits")).toContainText(/at the table \d+ minutes/, { timeout: 45_000 });
  expect(P.errors, P.errors.join("\n")).toEqual([]);
});
