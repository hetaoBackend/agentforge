// Shared channel helpers extracted from telegram.ts / weixin.ts / feishu.ts.
//
// These pin the one deliberate behaviour change made during the extraction:
// the markdown-image regex now excludes newlines inside `(...)`, matching what
// feishu.ts already did. Telegram and WeChat previously used `[^)]+`, which let
// an unclosed `(` swallow content across lines.

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  expanduser,
  file_url_path,
  is_plain_object,
  unquote,
} from "../src/channels/path_utils.ts";
import {
  UPLOADABLE_IMAGE_SUFFIXES,
  is_uploadable_image,
  markdown_image_refs,
  replace_markdown_image_refs,
} from "../src/channels/image_utils.ts";

describe("path_utils", () => {
  test("file_url_path drops scheme and netloc", () => {
    expect(file_url_path("file:///tmp/a.png")).toBe("/tmp/a.png");
    expect(file_url_path("file://localhost/tmp/a.png")).toBe("/tmp/a.png");
    expect(file_url_path("file://")).toBe("");
  });

  test("unquote percent-decodes, leaving malformed input untouched", () => {
    expect(unquote("/tmp/a%20b.png")).toBe("/tmp/a b.png");
    expect(unquote("/tmp/100%.png")).toBe("/tmp/100%.png");
  });

  test("expanduser resolves ~ only at the start of a path", () => {
    expect(expanduser("~")).toBe(os.homedir());
    expect(expanduser("~/x")).toBe(path.join(os.homedir(), "x"));
    expect(expanduser("/abs/~/x")).toBe("/abs/~/x");
    expect(expanduser("~user/x")).toBe("~user/x");
  });

  test("is_plain_object rejects null and arrays", () => {
    expect(is_plain_object({ a: 1 })).toBe(true);
    expect(is_plain_object(null)).toBe(false);
    expect(is_plain_object([1])).toBe(false);
    expect(is_plain_object("x")).toBe(false);
  });
});

describe("image_utils", () => {
  test("is_uploadable_image accepts the shared suffix set, case-insensitively", () => {
    for (const suffix of UPLOADABLE_IMAGE_SUFFIXES) {
      expect(is_uploadable_image(`/tmp/x${suffix}`)).toBe(true);
    }
    expect(is_uploadable_image("/tmp/x.PNG")).toBe(true);
    expect(is_uploadable_image("/tmp/x.bmp")).toBe(false);
    expect(is_uploadable_image("/tmp/x")).toBe(false);
  });

  test("markdown_image_refs collects every target in order", () => {
    expect(markdown_image_refs("![a](/x.png) and ![b](/y.png)")).toEqual([
      "/x.png",
      "/y.png",
    ]);
    expect(markdown_image_refs("")).toEqual([]);
    expect(markdown_image_refs("no images here")).toEqual([]);
  });

  test("markdown_image_refs does not let a ref span newlines", () => {
    // Previously `[^)]+` matched across the newline and captured
    // "unclosed\nkeep this" — stripping unrelated content downstream.
    expect(markdown_image_refs("![a](unclosed\nkeep this)")).toEqual([]);
    expect(markdown_image_refs("![a](/x.png)\n![b](/y.png)")).toEqual([
      "/x.png",
      "/y.png",
    ]);
  });

  test("replace_markdown_image_refs rewrites per match", () => {
    expect(
      replace_markdown_image_refs("keep ![x](/a.png) text", (full, ref) =>
        ref === "/a.png" ? "" : full,
      ),
    ).toBe("keep  text");
    expect(
      replace_markdown_image_refs("keep ![x](/b.png) text", (full, ref) =>
        ref === "/a.png" ? "" : full,
      ),
    ).toBe("keep ![x](/b.png) text");
  });

  test("regex state is not shared between calls", () => {
    const content = "![a](/x.png) ![b](/y.png)";
    expect(markdown_image_refs(content)).toEqual(markdown_image_refs(content));
  });
});
