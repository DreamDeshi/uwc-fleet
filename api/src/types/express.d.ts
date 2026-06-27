import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: Role;
      };
      // Set when a request authenticated with the static GPS vendor API key
      // (GPS_VENDOR_API_KEY) instead of a driver JWT — see POST /locations.
      gpsVendor?: boolean;
    }
  }
}

export {};
