import { RoomClient } from "@/components/RoomClient";

export default async function RoomPage({ params, searchParams }: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const remind = Number(sp.remind);
  return (
    <RoomClient
      code={code.toUpperCase().slice(0, 5)}
      watchParam={sp.watch === "1"}
      botsParam={sp.bots === "1"}
      remindSec={Number.isFinite(remind) && remind >= 30 ? remind : 20 * 60}
    />
  );
}
