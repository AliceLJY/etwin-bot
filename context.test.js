import { describe, expect, test } from "bun:test";
import {
  buildLatestCheckpointCommand,
  buildLatestCheckpointSshArgs,
  quoteRemoteShellArg,
} from "./context.js";


describe("RecallNest remote command", () => {
  test("single-quotes scope values for the remote shell", () => {
    expect(quoteRemoteShellArg("scope'$(not-run)")).toBe("'scope'\\''$(not-run)'");
  });

  test("uses home-relative runtime paths without embedding a username", () => {
    const command = buildLatestCheckpointCommand("project:etwin-bot");
    expect(command).toContain('cd "$HOME/recallnest"');
    expect(command).toContain('"$HOME/.bun/bin/bun"');
    expect(command).toContain("--scope 'project:etwin-bot'");
    expect(command).not.toContain("/Users/");
  });

  test("the SSH call terminates local option parsing before the configured host", () => {
    const args = buildLatestCheckpointSshArgs("mini", "project:etwin-bot");
    expect(args.slice(0, 2)).toEqual(["--", "mini"]);
    expect(args[2]).toContain("--scope 'project:etwin-bot'");
  });
});
