import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LINK_BASE, packageReadme, relativeLinks } from "./sync-package-readme.mjs";

describe("packageReadme", () => {
  test("makes ./ links, images, reference definitions and HTML attributes absolute", () => {
    const out = packageReadme(
      [
        "[usage](./docs/usage.md#top) ![logo](./logo.png)",
        "[ref]: ./docs/redis.md",
        "<img src=\"./logo.png\"> <a href='./docs/a.md'>a</a>",
      ].join("\n"),
    );
    assert.equal(
      out,
      [
        `[usage](${LINK_BASE}docs/usage.md#top) ![logo](${LINK_BASE}logo.png)`,
        `[ref]: ${LINK_BASE}docs/redis.md`,
        `<img src="${LINK_BASE}logo.png"> <a href='${LINK_BASE}docs/a.md'>a</a>`,
      ].join("\n"),
    );
    assert.deepEqual(relativeLinks(out), []);
  });
});

describe("relativeLinks", () => {
  test("accepts http, https, mailto and pure anchors", () => {
    const text = "[a](https://x.dev) [b](http://x.dev) [c](mailto:me@x.dev) [d](#quick-start)";
    assert.deepEqual(relativeLinks(text), []);
  });

  test("names every relative target the rewrite does not handle", () => {
    const text = [
      "[a](docs/x.md) [b](../x.md) ![c](img/c.png)",
      "[ref]: docs/y.md",
      '<img src="logo.png">',
      '<a href="../z.md">z</a>',
    ].join("\n");
    assert.deepEqual(relativeLinks(packageReadme(text)), [
      "docs/x.md",
      "../x.md",
      "img/c.png",
      "docs/y.md",
      "logo.png",
      "../z.md",
    ]);
  });

  test("ignores code blocks and inline code", () => {
    const text = ["```js", "const a = [x](docs/x.md);", "```", "`[y](docs/y.md)`"].join("\n");
    assert.deepEqual(relativeLinks(text), []);
  });
});
