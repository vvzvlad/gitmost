// End-to-end test of the docmost-mcp client against a live Docmost server.
// Creates a throwaway page, exercises every code path, cleans up after itself.
// Usage: DOCMOST_API_URL=... DOCMOST_EMAIL=... DOCMOST_PASSWORD=... node test-e2e.mjs
import { DocmostClient } from "./build/client.js";
import axios from "axios";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";

const API = process.env.DOCMOST_API_URL;
if (!API || !process.env.DOCMOST_EMAIL || !process.env.DOCMOST_PASSWORD) {
  console.error("Set DOCMOST_API_URL, DOCMOST_EMAIL and DOCMOST_PASSWORD env variables.");
  process.exit(2);
}
const APP = API.replace(/\/api\/?$/, "");
const client = new DocmostClient(API, process.env.DOCMOST_EMAIL, process.env.DOCMOST_PASSWORD);

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failed++;
};

// Minimal solid-color PNG encoder using Node built-ins only (no dependencies).
// Returns a valid PNG buffer for a 1x1 image of the given RGB color.
const crc32 = (buf) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};
const makePng = (r, g, b) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // One scanline: filter byte 0 followed by one RGB pixel.
  const raw = Buffer.from([0, r, g, b]);
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const MD = `:::info
**Тестовый callout.** Он должен стать узлом callout, а не blockquote.
:::

Первый абзац с **жирным** и [ссылкой](https://example.com). Маркер тут [1] стоит.

## Раздел два

| Колонка А | Колонка Б |
| --- | --- |
| раз | два |
| три | четыре |

Последний абзац со словом БУКВОЕД для замены.
`;

async function main() {
  const spaces = await client.getSpaces();
  const spaceId = spaces[0].id;
  let pageId = null;

  try {
    // 1. createPage: title with spaces must survive (was: underscores bug)
    const created = await client.createPage("Тест апгрейда MCP сервера", MD, spaceId);
    pageId = created.data.id;
    check("createPage: title keeps spaces", created.data.title === "Тест апгрейда MCP сервера", created.data.title);
    check("createPage: slugId exposed", typeof created.data.slugId === "string" && created.data.slugId.length > 0, created.data.slugId);

    // 2. getPageJson: raw ProseMirror with callout + table
    const pj = await client.getPageJson(pageId);
    const types = pj.content.content.map((n) => n.type);
    check("getPageJson: callout node present", types.includes("callout"), types.join(","));
    check("getPageJson: table node present", types.includes("table"));
    check("getPageJson: slugId present", !!pj.slugId);

    // 3. editPageText: surgical replace, ids preserved
    const idsBefore = JSON.stringify(
      pj.content.content.filter((n) => n.attrs?.id).map((n) => n.attrs.id),
    );
    const editRes = await client.editPageText(pageId, [
      { find: "БУКВОЕД", replace: "КНИГОЛЮБ" },
      { find: "[1]", replace: "[42]" },
    ]);
    check("editPageText: both edits applied", editRes.applied.every((e) => e.replacements === 1));
    await new Promise((r) => setTimeout(r, 16000)); // wait for server persistence
    const pj2 = await client.getPageJson(pageId);
    const text2 = JSON.stringify(pj2.content);
    check("editPageText: replacement visible", text2.includes("КНИГОЛЮБ") && text2.includes("[42]"));
    check("editPageText: old text gone", !text2.includes("БУКВОЕД"));
    const idsAfter = JSON.stringify(
      pj2.content.content.filter((n) => n.attrs?.id).map((n) => n.attrs.id),
    );
    check("editPageText: block ids preserved", idsBefore === idsAfter);
    check("editPageText: callout survived", JSON.stringify(pj2.content).includes('"callout"'));
    check("editPageText: table survived", pj2.content.content.some((n) => n.type === "table"));

    // 4. error reporting: ambiguous and missing finds
    let err1 = "";
    try { await client.editPageText(pageId, [{ find: "Колонка", replace: "X" }]); } catch (e) { err1 = e.message; }
    check("editPageText: ambiguous match rejected", err1.includes("matches"), err1);
    let err2 = "";
    try { await client.editPageText(pageId, [{ find: "НЕСУЩЕСТВУЮЩЕЕ", replace: "X" }]); } catch (e) { err2 = e.message; }
    check("editPageText: missing text reported", err2.includes("not found"), err2);

    // 5. update_page (markdown): table + callout must survive the re-import
    // #647/#672 — full-body overwrite is baseHash-guarded: read fresh, then write WITH the hash.
    const updMdBase = await client.getPageJson(pageId);
    await client.updatePage(pageId, MD + "\nДобавленный абзац.\n", undefined, updMdBase.baseHash);
    await new Promise((r) => setTimeout(r, 16000));
    const pj3 = await client.getPageJson(pageId);
    const types3 = pj3.content.content.map((n) => n.type);
    check("update_page md: callout survives re-import", types3.includes("callout"), types3.join(","));
    check("update_page md: table survives re-import", types3.includes("table"));
    const tableNode = pj3.content.content.find((n) => n.type === "table");
    const cellText = JSON.stringify(tableNode);
    check("update_page md: table cells intact", cellText.includes("четыре") && cellText.includes("Колонка А"));

    // 6. updatePageJson: lossless write round-trip
    pj3.content.content.push({
      type: "paragraph",
      attrs: { id: "testidjsonpush", indent: 0, textAlign: null },
      content: [{ type: "text", text: "Абзац, добавленный через updatePageJson." }],
    });
    // #647/#672 — full-body overwrite is baseHash-guarded: reuse pj3's hash (no intervening write).
    await client.updatePageJson(pageId, pj3.content, undefined, pj3.baseHash);
    await new Promise((r) => setTimeout(r, 16000));
    const pj4 = await client.getPageJson(pageId);
    const lastNode = pj4.content.content[pj4.content.content.length - 1];
    check("updatePageJson: paragraph appended", JSON.stringify(pj4.content).includes("добавленный через updatePageJson"));
    check("updatePageJson: custom node id preserved", lastNode.attrs?.id === "testidjsonpush", lastNode.attrs?.id);

    // 6b. images: upload / insert / replace (clean src, fresh attachment on replace).
    // insertImage / replaceImage take an http(s) URL that the SERVER fetches;
    // local file paths are intentionally unsupported. The Docmost server runs on
    // the same host as this test, so serve the PNG bytes over a throwaway
    // localhost HTTP server it can reach.
    const bytesA = makePng(255, 0, 0); // red
    const bytesB = makePng(0, 0, 255); // blue (a DIFFERENT valid PNG)
    const imgServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(req.url === "/b.png" ? bytesB : bytesA);
    });
    await new Promise((resolve, reject) => {
      imgServer.once("error", reject);
      imgServer.listen(0, "127.0.0.1", resolve);
    });
    const imgPort = imgServer.address().port;
    const urlA = `http://127.0.0.1:${imgPort}/a.png`;
    const urlB = `http://127.0.0.1:${imgPort}/b.png`;
    try {
      // Independent login to fetch file bytes with the same cookie the editor uses.
      const login = await axios.post(
        `${API}/auth/login`,
        { email: process.env.DOCMOST_EMAIL, password: process.env.DOCMOST_PASSWORD },
        { validateStatus: () => true },
      );
      const token = (login.headers["set-cookie"] || [])
        .find((c) => c.startsWith("authToken="))
        ?.split(";")[0]
        .split("=")[1];
      const fetchFile = (src) =>
        axios.get(`${APP}${src}`, {
          headers: { Cookie: `authToken=${token}` },
          responseType: "arraybuffer",
          validateStatus: () => true,
        });

      // insertImage: append the first PNG, src must be clean (no ?v=) and fetchable.
      const ins = await client.insertImage(pageId, urlA);
      check("insertImage: src has no ?v= cache-buster", !ins.src.includes("?v="), ins.src);
      const fileA = await fetchFile(ins.src);
      check("insertImage: file fetch returns 200", fileA.status === 200, `status=${fileA.status}`);
      check(
        "insertImage: content-type is image/*",
        String(fileA.headers["content-type"] || "").startsWith("image/"),
        String(fileA.headers["content-type"]),
      );

      await new Promise((r) => setTimeout(r, 16000));
      const pjImg = await client.getPageJson(pageId);
      const findImage = (nodes, id) => {
        for (const n of nodes || []) {
          if (n.type === "image" && (!id || n.attrs?.attachmentId === id)) return n;
          const found = findImage(n.content, id);
          if (found) return found;
        }
        return null;
      };
      const imgNode = findImage(pjImg.content.content);
      const oldAttachmentId = imgNode?.attrs?.attachmentId;
      check("insertImage: image node present after persist", !!oldAttachmentId, oldAttachmentId);

      // replaceImage: must create a NEW attachment with a clean, fetchable URL.
      // The 200 fetch is the assertion that catches the in-place-overwrite HTTP 500 regression.
      const rep = await client.replaceImage(pageId, oldAttachmentId, urlB);
      check("replaceImage: new attachment id differs from old", rep.newAttachmentId !== oldAttachmentId, `${oldAttachmentId} -> ${rep.newAttachmentId}`);
      check("replaceImage: src has no ?v= cache-buster", !rep.src.includes("?v="), rep.src);
      const fileB = await fetchFile(rep.src);
      check("replaceImage: new file fetch returns 200", fileB.status === 200, `status=${fileB.status}`);
      check(
        "replaceImage: new content-type is image/*",
        String(fileB.headers["content-type"] || "").startsWith("image/"),
        String(fileB.headers["content-type"]),
      );

      await new Promise((r) => setTimeout(r, 16000));
      const pjImg2 = await client.getPageJson(pageId);
      check("replaceImage: page has new attachment id", !!findImage(pjImg2.content.content, rep.newAttachmentId), rep.newAttachmentId);
      check("replaceImage: old attachment id repointed away", !findImage(pjImg2.content.content, oldAttachmentId), oldAttachmentId);
    } finally {
      imgServer.close();
    }

    // 6c. rich formatting: callout type, task list, inline marks, table alignment,
    // and literal $-pattern edits. Runs on its own throwaway page so it does not
    // disturb the markdown-export assumptions of later sections.
    {
      const findNodes = (n, t, acc = []) => {
        if (!n) return acc;
        if (n.type === t) acc.push(n);
        for (const ch of n.content || []) findNodes(ch, t, acc);
        return acc;
      };
      const marksOf = (n, acc = new Set()) => {
        if (!n) return acc;
        for (const m of n.marks || []) acc.add(m.type);
        for (const ch of n.content || []) marksOf(ch, acc);
        return acc;
      };
      const FMD = [
        ":::warning", "Warning callout with СЛОВО.", ":::", "",
        "- [x] done", "- [ ] todo", "",
        "Marks: <mark>hl</mark> <sub>lo</sub> <sup>hi</sup>.", "",
        "| L | C | R |", "|:--|:-:|--:|", "| a | b | c |", "",
        "Edit anchor PRICEMARK.",
      ].join("\n");
      const featPng = join(tmpdir(), `mcp-e2e-feat-${Date.now()}.png`);
      writeFileSync(featPng, makePng(0, 255, 0));
      const fp = await client.createPage("E2E features " + Date.now(), "init", spaceId);
      const fid = fp.data.id;
      try {
        // #647/#672 — full-body overwrite is baseHash-guarded: read fresh, then write WITH the hash.
        const featBase = await client.getPageJson(fid);
        await client.updatePage(fid, FMD, undefined, featBase.baseHash);
        await new Promise((r) => setTimeout(r, 16000));
        const fj = (await client.getPageJson(fid)).content;
        check("feature: callout type 'warning' preserved (was coerced to info)", findNodes(fj, "callout").some((n) => n.attrs?.type === "warning"), JSON.stringify(findNodes(fj, "callout").map((n) => n.attrs?.type)));
        check("feature: task list imported (taskList + 2 taskItems)", findNodes(fj, "taskList").length >= 1 && findNodes(fj, "taskItem").length === 2, `tl=${findNodes(fj, "taskList").length} ti=${findNodes(fj, "taskItem").length}`);
        check("feature: task checked states preserved", findNodes(fj, "taskItem").some((n) => n.attrs?.checked === true) && findNodes(fj, "taskItem").some((n) => n.attrs?.checked === false));
        const mk = [...marksOf(fj)];
        check("feature: highlight/subscript/superscript marks imported", ["highlight", "subscript", "superscript"].every((m) => mk.includes(m)), mk.join(","));
        check("feature: table cell alignment imported", JSON.stringify(findNodes(fj, "tableHeader").map((n) => n.attrs?.align)) === '["left","center","right"]', JSON.stringify(findNodes(fj, "tableHeader").map((n) => n.attrs?.align)));
        const fmd = (await client.getPage(fid)).data.content;
        check("feature: md export emits task checkboxes", fmd.includes("- [x]") && fmd.includes("- [ ]"));
        check("feature: md export emits table alignment markers", /:--|:-:|--:/.test(fmd));
        await client.editPageText(fid, [{ find: "PRICEMARK", replace: "$& costs $100" }]);
        await new Promise((r) => setTimeout(r, 16000));
        const ftext = JSON.stringify((await client.getPageJson(fid)).content);
        check("feature: editPageText inserts $-pattern literally (no $& expansion)", ftext.includes("$& costs $100") && !ftext.includes("PRICEMARK costs"));
        let badThrew = false;
        try { await client.replaceImage(fid, "00000000-0000-0000-0000-000000000000", featPng); } catch (e) { badThrew = /no image with attachmentId/.test(e.message); }
        check("feature: replaceImage with unknown id throws (no orphan upload)", badThrew);
      } finally {
        try { await client.deletePage(fid); } catch {}
        try { unlinkSync(featPng); } catch {}
      }
    }

    // 6d. node ops: patch / insert / delete a block by id on a throwaway page.
    // Three paragraphs are written with KNOWN ids via updatePageJson so the
    // ids can be targeted directly; each op is verified via getPageJson after
    // the standard 16s persistence wait.
    {
      const np = await client.createPage("E2E node-ops " + Date.now(), "init", spaceId);
      const nid = np.data.id;
      try {
        const mkPara = (id, text) => ({
          type: "paragraph",
          attrs: { id, indent: 0, textAlign: null },
          content: [{ type: "text", text }],
        });
        // Seed three paragraphs with known ids.
        // #647/#672 — full-body overwrite is baseHash-guarded: read fresh, then write WITH the hash.
        const nodeSeedBase = await client.getPageJson(nid);
        await client.updatePageJson(nid, {
          type: "doc",
          content: [
            mkPara("nodeops-a", "Alpha paragraph."),
            mkPara("nodeops-b", "Bravo paragraph."),
            mkPara("nodeops-c", "Charlie paragraph."),
          ],
        }, undefined, nodeSeedBase.baseHash);
        await new Promise((r) => setTimeout(r, 16000));

        // Read back the ids the server actually assigned.
        const seed = (await client.getPageJson(nid)).content;
        const seedIds = seed.content.map((n) => n.attrs?.id);
        check("node_ops: three seed paragraphs present", seed.content.length === 3, seedIds.join(","));
        const [idA, idB, idC] = seedIds;

        // patchNode: replace the middle paragraph; siblings' ids must be unchanged.
        // #413 XOR input: the raw ProseMirror node goes under the `node` key.
        await client.patchNode(nid, idB, { node: mkPara(idB, "Bravo PATCHED.") });
        await new Promise((r) => setTimeout(r, 16000));
        const afterPatch = (await client.getPageJson(nid)).content;
        const patchText = JSON.stringify(afterPatch);
        check("node_ops: patchNode applied new text", patchText.includes("Bravo PATCHED.") && !patchText.includes("Bravo paragraph."));
        const patchIds = afterPatch.content.map((n) => n.attrs?.id);
        check("node_ops: patchNode kept sibling ids", patchIds[0] === idA && patchIds[2] === idC, patchIds.join(","));

        // insertNode: place a new block after the first paragraph.
        await client.insertNode(
          nid,
          { node: mkPara("nodeops-ins", "Inserted paragraph.") },
          { position: "after", anchorNodeId: idA },
        );
        await new Promise((r) => setTimeout(r, 16000));
        const afterIns = (await client.getPageJson(nid)).content;
        const insIds = afterIns.content.map((n) => n.attrs?.id);
        const insText = afterIns.content.map((n) => JSON.stringify(n.content)).join("|");
        check("node_ops: insertNode added a block", afterIns.content.length === 4 && insText.includes("Inserted paragraph."));
        check("node_ops: insertNode placed block right after anchor", insIds[0] === idA && insIds[1] !== idB && insIds[2] === idB, insIds.join(","));

        // deleteNode: remove the last (Charlie) paragraph.
        await client.deleteNode(nid, idC);
        await new Promise((r) => setTimeout(r, 16000));
        const afterDel = (await client.getPageJson(nid)).content;
        const delText = JSON.stringify(afterDel);
        check("node_ops: deleteNode removed the block", !delText.includes("Charlie paragraph.") && !afterDel.content.some((n) => n.attrs?.id === idC));
      } finally {
        try { await client.deletePage(nid); } catch {}
      }
    }

    // 6e. renamePage: title-only update must leave the content untouched.
    {
      const rp = await client.createPage("E2E rename before " + Date.now(), "Rename body marker RENAMEBODY.", spaceId);
      const rid = rp.data.id;
      try {
        const beforeJson = (await client.getPageJson(rid)).content;
        const beforeContent = JSON.stringify(beforeJson);
        const newTitle = "E2E rename AFTER " + Date.now();
        const rr = await client.renamePage(rid, newTitle);
        check("renamePage: returns success+title", rr.success === true && rr.title === newTitle, JSON.stringify(rr));
        await new Promise((r) => setTimeout(r, 16000));
        const afterJson = await client.getPageJson(rid);
        check("renamePage: title changed", afterJson.title === newTitle, afterJson.title);
        check("renamePage: content unchanged", JSON.stringify(afterJson.content) === beforeContent && beforeContent.includes("RENAMEBODY"));
        const afterMd = (await client.getPage(rid)).data;
        check("renamePage: getPage reflects new title", afterMd.title === newTitle, afterMd.title);
      } finally {
        try { await client.deletePage(rid); } catch {}
      }
    }

    // 6f. updatePageJson title-only: omitting content updates the title and
    // leaves the body intact; supplying neither content nor title throws.
    {
      const up = await client.createPage("E2E upj-title before " + Date.now(), "Title-only body marker UPJTITLEBODY.", spaceId);
      const uid = up.data.id;
      try {
        const beforeContent = JSON.stringify((await client.getPageJson(uid)).content);
        const newTitle = "E2E upj-title AFTER " + Date.now();
        const ur = await client.updatePageJson(uid, undefined, newTitle);
        check("updatePageJson title-only: succeeds", ur.success === true, JSON.stringify(ur));
        await new Promise((r) => setTimeout(r, 16000));
        const afterJson = await client.getPageJson(uid);
        check("updatePageJson title-only: title updated", afterJson.title === newTitle, afterJson.title);
        check("updatePageJson title-only: content intact", JSON.stringify(afterJson.content) === beforeContent && beforeContent.includes("UPJTITLEBODY"));
        let upjErr = "";
        try { await client.updatePageJson(uid); } catch (e) { upjErr = e.message; }
        check("updatePageJson: neither content nor title throws", upjErr.includes("nothing to update"), upjErr);
      } finally {
        try { await client.deletePage(uid); } catch {}
      }
    }

    // 6g. copyPageContent: B's body becomes a copy of A's body, server-side,
    // while B's title/slugId stay put. Both pages are throwaways.
    {
      let aid = null;
      let bid = null;
      try {
        const aPage = await client.createPage("E2E copy SOURCE " + Date.now(), "Source marker COPYSOURCE only here.\n\nSecond source paragraph.", spaceId);
        aid = aPage.data.id;
        const bPage = await client.createPage("E2E copy TARGET " + Date.now(), "Target marker COPYTARGET only here.", spaceId);
        bid = bPage.data.id;

        const aJson = await client.getPageJson(aid);
        const bBefore = await client.getPageJson(bid);
        const bTitleBefore = bBefore.title;
        const bSlugBefore = bBefore.slugId;
        const aNodeCount = aJson.content.content.length;

        const cr = await client.copyPageContent(aid, bid);
        check("copyPageContent: returns success + node count", cr.success === true && cr.copiedNodes === aNodeCount, JSON.stringify(cr));
        await new Promise((r) => setTimeout(r, 16000));

        const bAfter = await client.getPageJson(bid);
        const bText = JSON.stringify(bAfter.content);
        check("copyPageContent: B now has A's marker", bText.includes("COPYSOURCE"));
        check("copyPageContent: B's old marker gone", !bText.includes("COPYTARGET"));
        check("copyPageContent: B node count equals A's", bAfter.content.content.length === aNodeCount, `${bAfter.content.content.length} vs ${aNodeCount}`);
        check("copyPageContent: B title unchanged", bAfter.title === bTitleBefore, bAfter.title);
        check("copyPageContent: B slugId unchanged", bAfter.slugId === bSlugBefore, bAfter.slugId);

        // Source must be left untouched by the copy.
        const aAfter = JSON.stringify((await client.getPageJson(aid)).content);
        check("copyPageContent: source page unchanged", aAfter === JSON.stringify(aJson.content) && aAfter.includes("COPYSOURCE"));

        let copyErr = "";
        try { await client.copyPageContent(aid, aid); } catch (e) { copyErr = e.message; }
        check("copyPageContent: self-copy rejected", copyErr.includes("same page"), copyErr);
      } finally {
        try { if (bid) await client.deletePage(bid); } catch {}
        try { if (aid) await client.deletePage(aid); } catch {}
      }
    }

    // 6h. markdown converter fixpoint (#476): pins the converter fixpoint
    // THROUGH the live server/collab path, not just the package tests. The
    // unit corpus (docmost-md-roundtrip) proves the converter alone is a
    // fixpoint; this asserts the property survives the real pipeline — export
    // (REST read, PM -> MD) -> import (MD -> PM -> collab replace -> server
    // persistence) -> export — where the server schema, the Yjs structural
    // diff or the collab write path could still mangle the doc while every
    // unit test stays green. importPageMarkdown is the designed inverse of
    // exportPageMarkdown (the self-contained envelope with meta/comments
    // blocks); updatePageMarkdown (client.updatePage) takes plain authoring
    // markdown and would re-import the envelope blocks as literal content.
    {
      const FIXMD = [
        "# Fixpoint heading",
        "",
        "Paragraph with **bold**, *italic* and a [link](https://example.com).",
        "",
        "## Second level",
        "",
        "- bullet one",
        "- bullet two",
        "",
        "1. ordered one",
        "2. ordered two",
        "",
        "```js",
        "const answer = 42; // code block must survive byte-identically",
        "```",
        "",
        "| A | B |",
        "| --- | --- |",
        "| one | two |",
        "",
        ":::info",
        "Callout body.",
        ":::",
      ].join("\n");
      const fx = await client.createPage("E2E md fixpoint " + Date.now(), FIXMD, spaceId);
      const fxid = fx.data.id;
      try {
        const md1 = await client.exportPageMarkdown(fxid);
        await client.importPageMarkdown(fxid, md1);
        await new Promise((r) => setTimeout(r, 16000)); // wait for server persistence
        const md2 = await client.exportPageMarkdown(fxid);
        // On failure, name the first diverging line of the two exports.
        const firstDiff = (a, b) => {
          const al = a.split("\n");
          const bl = b.split("\n");
          for (let i = 0; i < Math.max(al.length, bl.length); i++) {
            if (al[i] !== bl[i]) {
              return `first diff at line ${i + 1}: ${JSON.stringify(al[i] ?? "<EOF>")} -> ${JSON.stringify(bl[i] ?? "<EOF>")}`;
            }
          }
          return "same lines, different bytes (line endings?)";
        };
        check(
          "markdown fixpoint: export -> import -> export is byte-identical",
          md1 === md2,
          md1 === md2 ? "" : firstDiff(md1, md2),
        );
      } finally {
        try { await client.deletePage(fxid); } catch {}
      }
    }

    // 7. shares: create (idempotent), public access, list, unshare
    const share = await client.sharePage(pageId);
    check("sharePage: returns public URL", share.publicUrl?.startsWith(`${APP}/share/`), share.publicUrl);
    const share2 = await client.sharePage(pageId);
    check("sharePage: idempotent", share2.key === share.key);
    const anon = await axios.post(`${API}/shares/page-info`, { pageId: pj4.slugId, shareId: share.key }, { validateStatus: () => true });
    check("sharePage: anonymous access works", anon.status === 200);
    const shares = await client.listShares();
    check("listShares: contains our page", shares.some((s) => s.pageId === pageId && s.publicUrl === share.publicUrl));
    const un = await client.unsharePage(pageId);
    check("unsharePage: success", un.success === true);
    const anon2 = await axios.post(`${API}/shares/page-info`, { pageId: pj4.slugId, shareId: share.key }, { validateStatus: () => true });
    check("unsharePage: public access revoked", anon2.status !== 200, `status=${anon2.status}`);

    // 8. getPage markdown round-trip sanity (table separator present)
    const md = await client.getPage(pageId);
    check("getPage md: table separator emitted", md.data.content.includes("| --- |"), "");
    check("getPage md: callout exported as Obsidian '> [!info]'", md.data.content.includes("> [!info]"));

    // 9. comments: create / list / reply / update / check_new / delete
    const beforeComments = new Date(Date.now() - 1000).toISOString();
    // A top-level comment requires an inline "selection": exact contiguous text
    // that exists in the persisted page to anchor on. "Добавленный абзац." is a
    // plain paragraph re-imported in section 5 and still present here.
    const c1 = await client.createComment(pageId, "Первый **комментарий** с [ссылкой](https://example.com).", "inline", "Добавленный абзац.");
    check("createComment: created", !!c1.data.id, c1.data.id);
    check("createComment: markdown round-trip", c1.data.content.includes("**комментарий**"), c1.data.content);
    const reply = await client.createComment(pageId, "Ответ на комментарий.", "page", undefined, c1.data.id);
    check("createComment: reply has parent", reply.data.parentCommentId === c1.data.id);
    const list = (await client.listComments(pageId)).items;
    check("listComments: both visible", list.length === 2, `count=${list.length}`);
    await client.updateComment(c1.data.id, "Обновлённый текст комментария.");
    const got = await client.getComment(c1.data.id);
    check("updateComment + get_comment: content updated", got.data.content.includes("Обновлённый"), got.data.content);
    const news = await client.checkNewComments(spaceId, beforeComments, pageId);
    check("checkNewComments: finds new comments in subtree", news.totalNewComments >= 2, `total=${news.totalNewComments}`);
    // resolveComment: close the top-level thread, verify resolvedAt surfaces, then reopen
    const resolvedRes = await client.resolveComment(c1.data.id, true);
    check("resolveComment: marks resolved", resolvedRes.success === true && resolvedRes.resolved === true);
    // c1 is now resolved; the default feed hides resolved threads, so pass
    // includeResolved:true to still see it and assert its resolvedAt (#328).
    const listResolved = (await client.listComments(pageId, true)).items;
    const c1Resolved = listResolved.find((c) => c.id === c1.data.id);
    check("resolveComment: resolvedAt set in list", !!c1Resolved?.resolvedAt, `resolvedAt=${c1Resolved?.resolvedAt}`);
    const reopenedRes = await client.resolveComment(c1.data.id, false);
    check("resolveComment: reopen succeeds", reopenedRes.resolved === false);
    const listReopened = (await client.listComments(pageId)).items;
    const c1Reopened = listReopened.find((c) => c.id === c1.data.id);
    check("resolveComment: resolvedAt cleared on reopen", !c1Reopened?.resolvedAt, `resolvedAt=${c1Reopened?.resolvedAt}`);
    await client.deleteComment(reply.data.id);
    await client.deleteComment(c1.data.id);
    const listAfter = (await client.listComments(pageId)).items;
    check("deleteComment: comments removed", listAfter.length === 0, `count=${listAfter.length}`);
  } finally {
    if (pageId) {
      await client.deletePage(pageId);
      console.log("cleanup: test page deleted");
    }
  }

  console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TESTS FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
