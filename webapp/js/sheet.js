/* ── sheet.js — Google Sheets CSV fetcher & parser ───────────── */

const AH_SHEET = (() => {

  // Build the CSV export URL for a named tab
  function tabUrl(sheetId, tabName) {
    const encoded = encodeURIComponent(tabName);
    return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
  }

  // Fetch and parse a CSV tab
  async function fetchTab(sheetId, tabName) {
    const url = tabUrl(sheetId, tabName);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch tab: ${tabName} (${res.status})`);
    const text = await res.text();
    return parseCSV(text);
  }

  // Robust CSV parser — handles quoted fields with commas and newlines
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') { field += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { row.push(field.trim()); field = ""; }
        else if (ch === '\n' || (ch === '\r' && next === '\n')) {
          if (ch === '\r') i++;
          row.push(field.trim());
          if (row.some(f => f !== "")) rows.push(row);
          row = []; field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field || row.length) { row.push(field.trim()); if (row.some(f => f !== "")) rows.push(row); }
    return rows;
  }

  // Parse a student tab into structured data
  // Expected columns (0-indexed):
  //   0=Topic  1=SubtopicID  2=SubtopicName  3=RAG  4=Confidence  5=Date  6=Notes
  // Info rows (2-5): row[0]=label, row[1]=value
  function parseStudentTab(rows) {
    // Skip header rows — find data start (where column B looks like an ID)
    let dataStart = -1;
    let meta = { name: "", subject: "", tutor: "", startDate: "" };

    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const label = r[0].replace(/\[.*?\]/g, "").trim().toLowerCase();
      const value = (r[1] || "").replace(/\[.*?\]/g, "").trim();

      if (label.includes("student name")) meta.name = value;
      if (label.includes("subject")) meta.subject = value;
      if (label.includes("tutor")) meta.tutor = value;
      if (label.includes("start date")) meta.startDate = value;

      // Data starts when column B looks like a subtopic ID (contains a dash)
      if (dataStart === -1 && r[1] && r[1].includes("-") && !r[1].includes("Subtopic")) {
        dataStart = i;
      }
    }

    // Collect subtopic rows
    const subtopics = [];
    if (dataStart >= 0) {
      for (let i = dataStart; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[1]) continue;
        const id = r[1] || "";
        if (!id.includes("-")) continue; // skip non-data rows

        const rag = (r[3] || "").trim();
        const conf = parseInt(r[4] || "0", 10) || 0;
        const date = (r[5] || "").trim();
        const notes = (r[6] || "").trim();
        const isHigher = (r[2] || "").startsWith("★");
        const name = (r[2] || "").replace("★ ", "").trim();
        const topic = (r[0] || "").trim();

        subtopics.push({ id, topic, name, rag, conf, date, notes, isHigher });
      }
    }

    return { meta, subtopics };
  }

  // Parse overview tab for list of students
  // Expected: row[0]=name, row[1]=subject, row[2]=tutor, ...
  function parseOverviewTab(rows) {
    const students = [];
    // Skip header rows (first 3 rows based on template)
    for (let i = 3; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[0]) continue;
      const name = (r[0] || "").trim();
      if (!name || name.startsWith("[") || name.toLowerCase() === "student name") continue;
      students.push({
        name,
        subject: (r[1] || "").trim(),
        tutor:   (r[2] || "").trim(),
        // These will be recalculated from student tabs
        confident:   parseInt(r[3] || "0", 10) || 0,
        developing:  parseInt(r[4] || "0", 10) || 0,
        notStarted:  parseInt(r[5] || "0", 10) || 0,
        avgConf:     parseFloat(r[6] || "0") || 0,
        lastSession: (r[7] || "").trim(),
        // Slug for URL
        slug: slugify(name),
      });
    }
    return students;
  }

  function slugify(name) {
    return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }

  // Categorise RAG string
  function ragClass(rag) {
    if (!rag) return "grey";
    const r = rag.toLowerCase();
    if (r.includes("confident")) return "green";
    if (r.includes("developing")) return "amber";
    if (r.includes("not yet") || r.includes("not started")) return "red";
    return "grey";
  }

  function ragLabel(rag) {
    if (!rag) return "Not set";
    const r = rag.toLowerCase();
    if (r.includes("confident")) return "Confident";
    if (r.includes("developing")) return "Developing";
    if (r.includes("not yet") || r.includes("not started")) return "Not Yet Started";
    if (r.includes("not covered")) return "Not Covered";
    return rag;
  }

  function confClass(conf) {
    if (conf >= 4) return "high";
    if (conf >= 3) return "mid";
    if (conf >= 1) return "low";
    return "";
  }

  // Group subtopics by topic name
  function groupByTopic(subtopics) {
    const map = new Map();
    for (const st of subtopics) {
      if (!map.has(st.topic)) map.set(st.topic, []);
      map.get(st.topic).push(st);
    }
    return map;
  }

  // Compute summary stats from subtopics
  function computeStats(subtopics) {
    const active = subtopics.filter(s => !s.rag.toLowerCase().includes("not covered"));
    const confident  = subtopics.filter(s => ragClass(s.rag) === "green").length;
    const developing = subtopics.filter(s => ragClass(s.rag) === "amber").length;
    const notStarted = subtopics.filter(s => ragClass(s.rag) === "red").length;
    const notCovered = subtopics.filter(s => ragClass(s.rag) === "grey" && s.rag.toLowerCase().includes("not covered")).length;
    const total = active.length;
    const done = confident;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const confs = subtopics.filter(s => s.conf > 0).map(s => s.conf);
    const avgConf = confs.length > 0 ? (confs.reduce((a,b)=>a+b,0)/confs.length).toFixed(1) : null;
    // Last session date
    const dates = subtopics.map(s => s.date).filter(Boolean).sort();
    const lastSession = dates.length ? dates[dates.length - 1] : null;
    return { total, confident, developing, notStarted, notCovered, pct, avgConf, lastSession };
  }

  return { fetchTab, parseStudentTab, parseOverviewTab, ragClass, ragLabel, confClass, groupByTopic, computeStats, slugify };
})();
