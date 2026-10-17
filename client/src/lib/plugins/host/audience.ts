// presio.audience ("audience" permission): each viewer's input, collected per
// session. Designed (see issue #149) but not served yet: the methods exist so
// a plugin gets a clear Unavailable rather than MethodNotFound, and the host
// doesn't advertise the "audience" capability, so presio.supports("audience")
// is false.

import { HostError, type MethodTable } from "./types";

const unavailable = () => {
  throw new HostError("Unavailable", 'presio.audience isn\'t available in this version of Presio; check presio.supports("audience") first');
};

export const audienceMethods: MethodTable = Object.fromEntries(
  ["audience.set", "audience.open", "audience.close", "audience.clear", "audience.summary"].map((method) => [
    method,
    { permission: "audience" as const, handler: unavailable },
  ])
);
