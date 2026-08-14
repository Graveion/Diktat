import { test, expect } from "bun:test";
import { mergeProjects } from "./message-handler";

test("mergeProjects unions config + history, deduped and sorted", () => {
  const out = mergeProjects(
    ["/Users/me/personal/Diktat"],
    ["/Users/me/code/api", "/Users/me/personal/Diktat", "/Users/me/code/web"],
  );
  expect(out).toEqual([
    "/Users/me/code/api",
    "/Users/me/code/web",
    "/Users/me/personal/Diktat",
  ]);
});

test("mergeProjects with empty config returns history only", () => {
  expect(mergeProjects([], ["/a", "/a"])).toEqual(["/a"]);
});

test("mergeProjects with empty history returns config only", () => {
  expect(mergeProjects(["/b"], [])).toEqual(["/b"]);
});

test("mergeProjects both empty is empty", () => {
  expect(mergeProjects([], [])).toEqual([]);
});
