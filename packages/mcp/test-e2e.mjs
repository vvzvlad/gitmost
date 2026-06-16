// End-to-end test of the docmost-mcp client against a live Docmost server.
// Creates a throwaway page, exercises every code path, cleans up after itself.
// Usage: DOCMOST_API_URL=... DOCMOST_EMAIL=... DOCMOST_PASSWORD=... node test-e2e.mjs
import { DocmostClient } from "./build/client.js";
import axios from "axios";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

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
    // 1. create_page: title with spaces must survive (was: underscores bug)
    const created = await client.createPage("Тест апгрейда MCP сервера", MD, spaceId);
    pageId = created.data.id;
    check("create_page: title keeps spaces", created.data.title === "Тест апгрейда MCP сервера", created.data.title);
    check("create_page: slugId exposed", typeof created.data.slugId === "string" && created.data.slugId.length > 0, created.data.slugId);

    // 2. get_page_json: raw ProseMirror with callout + table
    const pj = await client.getPageJson(pageId);
    const types = pj.content.content.map((n) => n.type);
    check("get_page_json: callout node present", types.includes("callout"), types.join(","));
    check("get_page_json: table node present", types.includes("table"));
    check("get_page_json: slugId present", !!pj.slugId);

    // 3. edit_page_text: surgical replace, ids preserved
    const idsBefore = JSON.stringify(
      pj.content.content.filter((n) => n.attrs?.id).map((n) => n.attrs.id),
    );
    const editRes = await client.editPageText(pageId, [
      { find: "БУКВОЕД", replace: "КНИГОЛЮБ" },
      { find: "[1]", replace: "[42]" },
    ]);
    check("edit_page_text: both edits applied", editRes.edits.every((e) => e.replacements === 1));
    await new Promise((r) => setTimeout(r, 16000)); // wait for server persistence
    const pj2 = await client.getPageJson(pageId);
    const text2 = JSON.stringify(pj2.content);
    check("edit_page_text: replacement visible", text2.includes("КНИГОЛЮБ") && text2.includes("[42]"));
    check("edit_page_text: old text gone", !text2.includes("БУКВОЕД"));
    const idsAfter = JSON.stringify(
      pj2.content.content.filter((n) => n.attrs?.id).map((n) => n.attrs.id),
    );
    check("edit_page_text: block ids preserved", idsBefore === idsAfter);
    check("edit_page_text: callout survived", JSON.stringify(pj2.content).includes('"callout"'));
    check("edit_page_text: table survived", pj2.content.content.some((n) => n.type === "table"));

    // 4. error reporting: ambiguous and missing finds
    let err1 = "";
    try { await client.editPageText(pageId, [{ find: "Колонка", replace: "X" }]); } catch (e) { err1 = e.message; }
    check("edit_page_text: ambiguous match rejected", err1.includes("matches"), err1);
    let err2 = "";
    try { await client.editPageText(pageId, [{ find: "НЕСУЩЕСТВУЮЩЕЕ", replace: "X" }]); } catch (e) { err2 = e.message; }
    check("edit_page_text: missing text reported", err2.includes("not found"), err2);

    // 5. update_page (markdown): table + callout must survive the re-import
    await client.updatePage(pageId, MD + "\nДобавленный абзац.\n");
    await new Promise((r) => setTimeout(r, 16000));
    const pj3 = await client.getPageJson(pageId);
    const types3 = pj3.content.content.map((n) => n.type);
    check("update_page md: callout survives re-import", types3.includes("callout"), types3.join(","));
    check("update_page md: table survives re-import", types3.includes("table"));
    const tableNode = pj3.content.content.find((n) => n.type === "table");
    const cellText = JSON.stringify(tableNode);
    check("update_page md: table cells intact", cellText.includes("четыре") && cellText.includes("Колонка А"));

    // 6. update_page_json: lossless write round-trip
    pj3.content.content.push({
      type: "paragraph",
      attrs: { id: "testidjsonpush", indent: 0, textAlign: null },
      content: [{ type: "text", text: "Абзац, добавленный через update_page_json." }],
    });
    await client.updatePageJson(pageId, pj3.content);
    await new Promise((r) => setTimeout(r, 16000));
    const pj4 = await client.getPageJson(pageId);
    const lastNode = pj4.content.content[pj4.content.content.length - 1];
    check("update_page_json: paragraph appended", JSON.stringify(pj4.content).includes("добавленный через update_page_json"));
    check("update_page_json: custom node id preserved", lastNode.attrs?.id === "testidjsonpush", lastNode.attrs?.id);

    // 6b. images: upload / insert / replace (clean src, fresh attachment on replace)
    const pngA = join(tmpdir(), `mcp-e2e-img-a-${Date.now()}.png`);
    const pngB = join(tmpdir(), `mcp-e2e-img-b-${Date.now()}.png`);
    writeFileSync(pngA, makePng(255, 0, 0)); // red
    writeFileSync(pngB, makePng(0, 0, 255)); // blue (a DIFFERENT valid PNG)
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

      // insert_image: append the first PNG, src must be clean (no ?v=) and fetchable.
      const ins = await client.insertImage(pageId, pngA);
      check("insert_image: src has no ?v= cache-buster", !ins.src.includes("?v="), ins.src);
      const fileA = await fetchFile(ins.src);
      check("insert_image: file fetch returns 200", fileA.status === 200, `status=${fileA.status}`);
      check(
        "insert_image: content-type is image/*",
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
      check("insert_image: image node present after persist", !!oldAttachmentId, oldAttachmentId);

      // replace_image: must create a NEW attachment with a clean, fetchable URL.
      // The 200 fetch is the assertion that catches the in-place-overwrite HTTP 500 regression.
      const rep = await client.replaceImage(pageId, oldAttachmentId, pngB);
      check("replace_image: new attachment id differs from old", rep.newAttachmentId !== oldAttachmentId, `${oldAttachmentId} -> ${rep.newAttachmentId}`);
      check("replace_image: src has no ?v= cache-buster", !rep.src.includes("?v="), rep.src);
      const fileB = await fetchFile(rep.src);
      check("replace_image: new file fetch returns 200", fileB.status === 200, `status=${fileB.status}`);
      check(
        "replace_image: new content-type is image/*",
        String(fileB.headers["content-type"] || "").startsWith("image/"),
        String(fileB.headers["content-type"]),
      );

      await new Promise((r) => setTimeout(r, 16000));
      const pjImg2 = await client.getPageJson(pageId);
      check("replace_image: page has new attachment id", !!findImage(pjImg2.content.content, rep.newAttachmentId), rep.newAttachmentId);
      check("replace_image: old attachment id repointed away", !findImage(pjImg2.content.content, oldAttachmentId), oldAttachmentId);
    } finally {
      try { unlinkSync(pngA); } catch {}
      try { unlinkSync(pngB); } catch {}
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
        await client.updatePage(fid, FMD);
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
        check("feature: edit_page_text inserts $-pattern literally (no $& expansion)", ftext.includes("$& costs $100") && !ftext.includes("PRICEMARK costs"));
        let badThrew = false;
        try { await client.replaceImage(fid, "00000000-0000-0000-0000-000000000000", featPng); } catch (e) { badThrew = /no image with attachmentId/.test(e.message); }
        check("feature: replace_image with unknown id throws (no orphan upload)", badThrew);
      } finally {
        try { await client.deletePage(fid); } catch {}
        try { unlinkSync(featPng); } catch {}
      }
    }

    // 6d. node ops: patch / insert / delete a block by id on a throwaway page.
    // Three paragraphs are written with KNOWN ids via update_page_json so the
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
        await client.updatePageJson(nid, {
          type: "doc",
          content: [
            mkPara("nodeops-a", "Alpha paragraph."),
            mkPara("nodeops-b", "Bravo paragraph."),
            mkPara("nodeops-c", "Charlie paragraph."),
          ],
        });
        await new Promise((r) => setTimeout(r, 16000));

        // Read back the ids the server actually assigned.
        const seed = (await client.getPageJson(nid)).content;
        const seedIds = seed.content.map((n) => n.attrs?.id);
        check("node_ops: three seed paragraphs present", seed.content.length === 3, seedIds.join(","));
        const [idA, idB, idC] = seedIds;

        // patchNode: replace the middle paragraph; siblings' ids must be unchanged.
        await client.patchNode(nid, idB, mkPara(idB, "Bravo PATCHED."));
        await new Promise((r) => setTimeout(r, 16000));
        const afterPatch = (await client.getPageJson(nid)).content;
        const patchText = JSON.stringify(afterPatch);
        check("node_ops: patchNode applied new text", patchText.includes("Bravo PATCHED.") && !patchText.includes("Bravo paragraph."));
        const patchIds = afterPatch.content.map((n) => n.attrs?.id);
        check("node_ops: patchNode kept sibling ids", patchIds[0] === idA && patchIds[2] === idC, patchIds.join(","));

        // insertNode: place a new block after the first paragraph.
        await client.insertNode(
          nid,
          mkPara("nodeops-ins", "Inserted paragraph."),
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

    // 6e. rename_page: title-only update must leave the content untouched.
    {
      const rp = await client.createPage("E2E rename before " + Date.now(), "Rename body marker RENAMEBODY.", spaceId);
      const rid = rp.data.id;
      try {
        const beforeJson = (await client.getPageJson(rid)).content;
        const beforeContent = JSON.stringify(beforeJson);
        const newTitle = "E2E rename AFTER " + Date.now();
        const rr = await client.renamePage(rid, newTitle);
        check("rename_page: returns success+title", rr.success === true && rr.title === newTitle, JSON.stringify(rr));
        await new Promise((r) => setTimeout(r, 16000));
        const afterJson = await client.getPageJson(rid);
        check("rename_page: title changed", afterJson.title === newTitle, afterJson.title);
        check("rename_page: content unchanged", JSON.stringify(afterJson.content) === beforeContent && beforeContent.includes("RENAMEBODY"));
        const afterMd = (await client.getPage(rid)).data;
        check("rename_page: get_page reflects new title", afterMd.title === newTitle, afterMd.title);
      } finally {
        try { await client.deletePage(rid); } catch {}
      }
    }

    // 6f. update_page_json title-only: omitting content updates the title and
    // leaves the body intact; supplying neither content nor title throws.
    {
      const up = await client.createPage("E2E upj-title before " + Date.now(), "Title-only body marker UPJTITLEBODY.", spaceId);
      const uid = up.data.id;
      try {
        const beforeContent = JSON.stringify((await client.getPageJson(uid)).content);
        const newTitle = "E2E upj-title AFTER " + Date.now();
        const ur = await client.updatePageJson(uid, undefined, newTitle);
        check("update_page_json title-only: succeeds", ur.success === true, JSON.stringify(ur));
        await new Promise((r) => setTimeout(r, 16000));
        const afterJson = await client.getPageJson(uid);
        check("update_page_json title-only: title updated", afterJson.title === newTitle, afterJson.title);
        check("update_page_json title-only: content intact", JSON.stringify(afterJson.content) === beforeContent && beforeContent.includes("UPJTITLEBODY"));
        let upjErr = "";
        try { await client.updatePageJson(uid); } catch (e) { upjErr = e.message; }
        check("update_page_json: neither content nor title throws", upjErr.includes("nothing to update"), upjErr);
      } finally {
        try { await client.deletePage(uid); } catch {}
      }
    }

    // 6g. copy_page_content: B's body becomes a copy of A's body, server-side,
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
        check("copy_page_content: returns success + node count", cr.success === true && cr.copiedNodes === aNodeCount, JSON.stringify(cr));
        await new Promise((r) => setTimeout(r, 16000));

        const bAfter = await client.getPageJson(bid);
        const bText = JSON.stringify(bAfter.content);
        check("copy_page_content: B now has A's marker", bText.includes("COPYSOURCE"));
        check("copy_page_content: B's old marker gone", !bText.includes("COPYTARGET"));
        check("copy_page_content: B node count equals A's", bAfter.content.content.length === aNodeCount, `${bAfter.content.content.length} vs ${aNodeCount}`);
        check("copy_page_content: B title unchanged", bAfter.title === bTitleBefore, bAfter.title);
        check("copy_page_content: B slugId unchanged", bAfter.slugId === bSlugBefore, bAfter.slugId);

        // Source must be left untouched by the copy.
        const aAfter = JSON.stringify((await client.getPageJson(aid)).content);
        check("copy_page_content: source page unchanged", aAfter === JSON.stringify(aJson.content) && aAfter.includes("COPYSOURCE"));

        let copyErr = "";
        try { await client.copyPageContent(aid, aid); } catch (e) { copyErr = e.message; }
        check("copy_page_content: self-copy rejected", copyErr.includes("same page"), copyErr);
      } finally {
        try { if (bid) await client.deletePage(bid); } catch {}
        try { if (aid) await client.deletePage(aid); } catch {}
      }
    }

    // 7. shares: create (idempotent), public access, list, unshare
    const share = await client.sharePage(pageId);
    check("share_page: returns public URL", share.publicUrl?.startsWith(`${APP}/share/`), share.publicUrl);
    const share2 = await client.sharePage(pageId);
    check("share_page: idempotent", share2.key === share.key);
    const anon = await axios.post(`${API}/shares/page-info`, { pageId: pj4.slugId, shareId: share.key }, { validateStatus: () => true });
    check("share_page: anonymous access works", anon.status === 200);
    const shares = await client.listShares();
    check("list_shares: contains our page", shares.some((s) => s.pageId === pageId && s.publicUrl === share.publicUrl));
    const un = await client.unsharePage(pageId);
    check("unshare_page: success", un.success === true);
    const anon2 = await axios.post(`${API}/shares/page-info`, { pageId: pj4.slugId, shareId: share.key }, { validateStatus: () => true });
    check("unshare_page: public access revoked", anon2.status !== 200, `status=${anon2.status}`);

    // 8. get_page markdown round-trip sanity (table separator present)
    const md = await client.getPage(pageId);
    check("get_page md: table separator emitted", md.data.content.includes("| --- |"), "");
    check("get_page md: callout exported as :::", md.data.content.includes(":::info"));

    // 9. comments: create / list / reply / update / check_new / delete
    const beforeComments = new Date(Date.now() - 1000).toISOString();
    const c1 = await client.createComment(pageId, "Первый **комментарий** с [ссылкой](https://example.com).");
    check("create_comment: created", !!c1.data.id, c1.data.id);
    check("create_comment: markdown round-trip", c1.data.content.includes("**комментарий**"), c1.data.content);
    const reply = await client.createComment(pageId, "Ответ на комментарий.", "page", undefined, c1.data.id);
    check("create_comment: reply has parent", reply.data.parentCommentId === c1.data.id);
    const list = await client.listComments(pageId);
    check("list_comments: both visible", list.length === 2, `count=${list.length}`);
    await client.updateComment(c1.data.id, "Обновлённый текст комментария.");
    const got = await client.getComment(c1.data.id);
    check("update_comment + get_comment: content updated", got.data.content.includes("Обновлённый"), got.data.content);
    const news = await client.checkNewComments(spaceId, beforeComments, pageId);
    check("check_new_comments: finds new comments in subtree", news.totalNewComments >= 2, `total=${news.totalNewComments}`);
    await client.deleteComment(reply.data.id);
    await client.deleteComment(c1.data.id);
    const listAfter = await client.listComments(pageId);
    check("delete_comment: comments removed", listAfter.length === 0, `count=${listAfter.length}`);
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
