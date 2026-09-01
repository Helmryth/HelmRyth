import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVpsCommandRunner,
  type VpsProcessSpawner,
  type VpsSpawnedProcess,
} from "./vps-computer.ts";

class FakeChild extends EventEmitter implements VpsSpawnedProcess {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal: NodeJS.Signals) => true);
}

describe("default VPS command runner", () => {
  const spawnProcess = vi.fn<VpsProcessSpawner>();
  const runner = createVpsCommandRunner(spawnProcess);

  function fakeChild(): FakeChild {
    const child = new FakeChild();
    spawnProcess.mockReturnValue(child);
    return child;
  }

  beforeEach(() => {
    spawnProcess.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects output and resolves after the child closes", async () => {
    const child = fakeChild();
    const result = runner(["info"], { input: "request" });

    child.stdout.write("out");
    child.stderr.write("err");
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({ stdout: "out", stderr: "err" });
    expect(spawnProcess).toHaveBeenCalledWith("docker", ["info"], expect.objectContaining({ shell: false }));
  });

  it("turns stdin EPIPE into a rejected command instead of an unhandled error", async () => {
    const child = fakeChild();
    const result = runner(["build", "-"], { input: "Dockerfile" });

    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(result).rejects.toThrow("Docker-over-SSH stdin failed: write EPIPE");
    child.emit("close", 1, null);
  });

  it("escalates a timed-out command from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = runner(["info"], { timeoutMs: 100 });
    const rejection = expect(result).rejects.toThrow("Docker-over-SSH command timed out");

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    // the WAN-sized grace window: ssh + docker get 5s to tear down cleanly
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});
