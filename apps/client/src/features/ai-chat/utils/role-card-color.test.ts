import { describe, it, expect } from "vitest";
import { ROLE_CARD_PALETTE, roleCardColor } from "./role-card-color";

describe("roleCardColor", () => {
  it("has a 10-color palette", () => {
    expect(ROLE_CARD_PALETTE).toHaveLength(10);
  });

  it("maps index 0 to the first palette color (blue)", () => {
    expect(roleCardColor(0)).toBe("blue");
    expect(roleCardColor(1)).toBe("grape");
  });

  it("wraps around at the end of the palette", () => {
    expect(roleCardColor(10)).toBe("blue");
    expect(roleCardColor(11)).toBe("grape");
  });

  it("is safe for negative indices", () => {
    expect(roleCardColor(-1)).toBe("violet");
    expect(roleCardColor(-10)).toBe("blue");
  });
});
