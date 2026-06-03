import { formatToolLabel } from "../tools";

describe("formatToolLabel", () => {
  it("maps a known tool to its label and icon", () => {
    expect(formatToolLabel("Read")).toEqual({ label: "Reading", icon: "📄" });
  });

  it("falls back to the raw name and wrench icon for unknown tools", () => {
    expect(formatToolLabel("FooBar")).toEqual({ label: "FooBar", icon: "🔧" });
  });

  it("appends the file segment for a known tool with a colon", () => {
    expect(formatToolLabel("Read:auth.ts")).toEqual({
      label: "Reading auth.ts",
      icon: "📄",
    });
  });

  it("uses the raw name + file for an unknown tool with a colon", () => {
    expect(formatToolLabel("Foo:bar.ts")).toEqual({
      label: "Foo bar.ts",
      icon: "🔧",
    });
  });

  it("splits on the first colon only", () => {
    expect(formatToolLabel("Bash:a:b")).toEqual({
      label: "Running a:b",
      icon: "⚡",
    });
  });

  it("maps MultiEdit, Edit and Write to editing labels", () => {
    expect(formatToolLabel("MultiEdit").label).toBe("Editing");
    expect(formatToolLabel("Edit").label).toBe("Editing");
    expect(formatToolLabel("Write").label).toBe("Writing");
  });
});
