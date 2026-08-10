import { describe, expect, it } from "bun:test";
import { buildPairedConfig, parsePairArgs, relayHttpBase } from "./pair.ts";

describe("parsePairArgs", () => {
  it("takes the first non-flag arg as the code", () => {
    expect(parsePairArgs(["ABCD1234"])).toEqual({ code: "ABCD1234", relayUrl: undefined, name: undefined });
  });

  it("parses --relay and --name in any order", () => {
    expect(parsePairArgs(["--relay", "wss://r.example", "CODE", "--name", "Studio Mac"])).toEqual({
      code: "CODE",
      relayUrl: "wss://r.example",
      name: "Studio Mac",
    });
  });

  it("returns empty code when none given", () => {
    expect(parsePairArgs(["--relay", "wss://r.example"]).code).toBe("");
  });
});

describe("relayHttpBase", () => {
  it("maps wss -> https and strips trailing slash", () => {
    expect(relayHttpBase("wss://x.trycloudflare.com/")).toBe("https://x.trycloudflare.com");
  });
  it("maps ws -> http", () => {
    expect(relayHttpBase("ws://localhost:9090")).toBe("http://localhost:9090");
  });
  it("leaves https untouched", () => {
    expect(relayHttpBase("https://relay.diktat.app")).toBe("https://relay.diktat.app");
  });
});

describe("buildPairedConfig", () => {
  it("sets relay mode + credentials while preserving port/projects", () => {
    const out = buildPairedConfig(
      { port: 9001, projects: ["/a"], somethingElse: true },
      { relayUrl: "wss://r", machineId: "m1", daemonToken: "tok" },
    );
    expect(out).toEqual({
      port: 9001,
      projects: ["/a"],
      somethingElse: true,
      mode: "relay",
      relayUrl: "wss://r",
      machineId: "m1",
      daemonToken: "tok",
    });
  });

  it("defaults port and projects when absent", () => {
    const out = buildPairedConfig({}, { relayUrl: "wss://r", machineId: "m1", daemonToken: "tok" });
    expect(out.port).toBe(9000);
    expect(out.projects).toEqual([]);
  });
});
