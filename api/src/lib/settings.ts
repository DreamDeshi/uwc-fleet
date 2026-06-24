import { prisma } from "./prisma";

// System-wide settings live in a single AppSetting row (id "singleton").
// These helpers read/write it, creating the row with defaults on first access.
const SINGLETON_ID = "singleton";

export type DispatchMode = "manual" | "auto";

export async function getDispatchMode(): Promise<DispatchMode> {
  const row = await prisma.appSetting.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    create: { id: SINGLETON_ID },
    select: { dispatch_mode: true },
  });
  return row.dispatch_mode;
}

export async function setDispatchMode(mode: DispatchMode): Promise<DispatchMode> {
  const row = await prisma.appSetting.upsert({
    where: { id: SINGLETON_ID },
    update: { dispatch_mode: mode },
    create: { id: SINGLETON_ID, dispatch_mode: mode },
    select: { dispatch_mode: true },
  });
  return row.dispatch_mode;
}
