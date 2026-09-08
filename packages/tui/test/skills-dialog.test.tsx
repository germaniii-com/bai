import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { BaiClient } from "@bai/api/client";
import type { Session, SkillInfo } from "@bai/shared";
import { SkillsDialog } from "../src/views/skills";

/**
 * The skills dialog: sliding-window list, detail view (enter), delete
 * confirm (d), and the learn flow (l → PromptDialog → learnSkill → hand the
 * session to the App). Mirrors the agent-manager dialog tests.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function skill(i: number): SkillInfo {
  return {
    name: `skill-${String(i).padStart(2, "0")}`,
    description: `skill ${i}`,
    body: `# Skill ${i}\n\nBody text.`,
    source: "file",
    path: `/tmp/skill-${i}/SKILL.md`,
    linkedFiles: [],
  };
}

const skills = Array.from({ length: 30 }, (_, i) => skill(i));

function stubClient(opts: { learned?: unknown[] } = {}): BaiClient {
  return {
    listSkills: async () => skills,
    getSkill: async (name: string) => {
      const found = skills.find((s) => s.name === name);
      return found === undefined ? undefined : { skill: found, usage: { views: 3, sessions: 2 } };
    },
    deleteSkill: async () => true,
    putSkill: async () => skills[0] as SkillInfo,
    learnSkill: async (body: { request: string }) => {
      opts.learned?.push(body.request);
      return { id: "ses_learn", title: "Learn: x", workbench: "chat", meta: {} } as unknown as Session;
    },
  } as unknown as BaiClient;
}

describe("SkillsDialog", () => {
  test("long skill lists render a sliding window with more-indicators", async () => {
    const { lastFrame, unmount } = render(<SkillsDialog client={stubClient()} catalogTick={0} onLearned={() => {}} onDone={() => {}} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("skill-00");
    expect(frame).toContain("skill-11");
    expect(frame).not.toContain("skill-12 ");
    expect(frame).toContain("↓ 18 more");
  });

  test("enter opens the detail view with the body and usage; enter again closes", async () => {
    const { stdin, lastFrame, unmount } = render(<SkillsDialog client={stubClient()} catalogTick={0} onLearned={() => {}} onDone={() => {}} />);
    await tick();
    stdin.write("\r");
    await tick(50);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Body text.");
    expect(frame).toContain("3 views");
    expect(frame).toContain("2 sessions");
    stdin.write("\r");
    await tick(50);
    frame = lastFrame() ?? "";
    expect(frame).not.toContain("Body text.");
    unmount();
  });

  test("d asks for confirmation; y deletes", async () => {
    let deleted = "";
    const client = stubClient();
    (client as unknown as { deleteSkill: (name: string) => Promise<boolean> }).deleteSkill = async (name: string) => {
      deleted = name;
      return true;
    };
    const { stdin, lastFrame, unmount } = render(<SkillsDialog client={client} catalogTick={0} onLearned={() => {}} onDone={() => {}} />);
    await tick();
    stdin.write("d");
    await tick();
    expect(lastFrame() ?? "").toContain('delete "skill-00"? y/n');
    stdin.write("y");
    await tick(50);
    unmount();
    expect(deleted).toBe("skill-00");
  });

  test("l opens the learn prompt; a request spawns a learn session", async () => {
    const learned: unknown[] = [];
    const { stdin, lastFrame, unmount } = render(
      <SkillsDialog client={stubClient({ learned })} catalogTick={0} onLearned={() => {}} onDone={() => {}} />,
    );
    await tick();
    stdin.write("l");
    await tick();
    expect(lastFrame() ?? "").toContain("learn a skill");
    stdin.write("the arxiv API docs");
    await tick();
    stdin.write("\r");
    await tick(50);
    unmount();
    expect(learned).toEqual(["the arxiv API docs"]);
  });
});
