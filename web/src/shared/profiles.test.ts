import { describe, expect, test } from "bun:test";
import { cleanProfiles, profileProblems, profilesToSave } from "./profiles";

describe("profileProblems", () => {
  test("a named profile with a model is fine", () => {
    expect(profileProblems([{ name: "a", chain: ["claude-code:opus"] }])).toEqual([undefined]);
  });
  test("no models (blank entries don't count)", () => {
    expect(profileProblems([{ name: "a", chain: [] }, { name: "b", chain: ["  "] }])).toEqual(["Add at least one model", "Add at least one model"]);
  });
  test("missing or duplicate names", () => {
    const p = profileProblems([
      { name: " ", chain: ["x:y"] },
      { name: "a", chain: ["x:y"] },
      { name: "a ", chain: ["x:y"] },
    ]);
    expect(p[0]).toBe("Give the profile a name");
    expect(p[1]).toBeUndefined();
    expect(p[2]).toContain("already called");
  });
  test("cleanProfiles trims", () => {
    expect(cleanProfiles([{ name: " a ", chain: [" x:y ", ""] }])).toEqual([{ name: "a", chain: ["x:y"] }]);
  });
});

describe("profilesToSave", () => {
  const a = { name: "a", chain: ["claude-code:opus"] };
  test("nothing before they load, or while they match what's saved (ignoring stray spaces)", () => {
    expect(profilesToSave(undefined, [a])).toBeUndefined();
    expect(profilesToSave([a], [a])).toBeUndefined();
    expect(profilesToSave([{ name: "a ", chain: [" claude-code:opus", ""] }], [a])).toBeUndefined();
  });
  test("a valid change is saved; any invalid profile holds the whole list back", () => {
    const b = { name: "b", chain: ["codex:gpt-6"] };
    expect(profilesToSave([a, b], [a])).toEqual([a, b]);
    expect(profilesToSave([], [a])).toEqual([]);
    expect(profilesToSave([a, { name: "", chain: [] }], [a])).toBeUndefined();
    expect(profilesToSave([a], undefined)).toEqual([a]); // a failed save is retried
  });
});
