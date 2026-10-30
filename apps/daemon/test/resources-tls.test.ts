import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { certificateDays } from "../src/resources.js";

vi.mock("node:tls", () => ({ connect: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(connect).mockReset(); });

it("gets expiry from the TLS peer for the exact preview host/port and closes the connection", async () => {
  const now = Date.parse("2026-10-30T12:00:00Z"); vi.spyOn(Date, "now").mockReturnValue(now);
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn(), getPeerCertificate: () => ({ valid_to: new Date(now + 71 * 86400_000).toUTCString() }) });
  vi.mocked(connect).mockImplementationOnce(((options: unknown, ready: () => void) => { queueMicrotask(ready); return socket as unknown as TLSSocket; }) as typeof connect);
  expect(await certificateDays("https://preview.tailnet.ts.net:4700/path")).toBe(71);
  expect(connect).toHaveBeenCalledWith({ host: "preview.tailnet.ts.net", port: 4700, servername: "preview.tailnet.ts.net" }, expect.any(Function));
  expect(socket.destroy).toHaveBeenCalledOnce();
});

it("omits certificate days after a failed TLS handshake", async () => {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
  vi.mocked(connect).mockImplementationOnce((() => { queueMicrotask(() => socket.emit("error", new Error("certificate rejected"))); return socket as unknown as TLSSocket; }) as typeof connect);
  expect(await certificateDays("https://preview.tailnet.ts.net")).toBeNull();
  expect(socket.destroy).toHaveBeenCalledOnce();
});
