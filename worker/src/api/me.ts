import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { folderLink } from "../drive/client";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/", (c) => {
  const u = c.var.user;
  return c.json({
    name: u.name,
    email: u.email,
    defaultCurrency: u.defaultCurrency,
    driveStatus: u.driveStatus,
    driveFolderLink: u.driveFolderId ? folderLink(u.driveFolderId) : null,
  });
});
