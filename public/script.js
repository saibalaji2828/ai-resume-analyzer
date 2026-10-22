/* ResumeIQ — AI Resume Analyzer
   Account-specific history, resume upload, AI analysis,
   SQL false-negative correction, and PDF report download.
*/
"use strict";

const $ = (id) => document.getElementById(id);

const resumeForm = $("resumeForm");
const resumeFile = $("resumeFile");
const uploadZone = $("uploadZone");
const uploadTitle = $("selectedFileName");
const uploadSubtitle = $("selectedFileMeta");
const selectedFileBox = $("selectedFile");
const jobTitle = $("jobTitle");
const jobDescription = $("jobDescription");
const analyzeButton = $("analyzeButton");
const statusMessage = $("statusMessage");
const results = $("results");
const scoreRing = $("scoreRing");
const scoreNumber = $("scoreNumber");
const scoreMeterFill = $("scoreMeterFill");
const scoreDescription = $("scoreDescription");
const matchScore = $("matchScore");
const matchedCount = $("matchedCount");
const missingCount = $("missingCount");
const jobSkillCount = $("jobSkillCount");
const matchingSkills = $("matchingSkills");
const missingSkills = $("missingSkills");
const suggestions = $("suggestions");
const downloadButton = $("downloadButton");
const resetButton = $("resetButton");
const removeFileButton = $("removeFileButton");
const historyList = $("historyList");
const emptyHistory = $("emptyHistory");
const historyBadge = $("historyBadge");
const clearHistoryButton = $("clearHistoryButton");
const coverageBar = $("coverageBar");
const coverageText = $("coverageText");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_HISTORY = 50;
const HISTORY_KEY_PREFIX = "resumeIQ_history_user_";

let currentHistoryUserId = null;
let selectedResume = null;
let latestReport = null;
let historyItems = [];

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* -------------------- GENERAL HELPERS -------------------- */

function setStatus(message, type = "") {
  if (!statusMessage) return;

  statusMessage.textContent = message;
  statusMessage.className =
    `status-message${type ? ` ${type}` : ""}`;
}

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = String(value ?? "");
  }
}

function makeId() {
  return window.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return "";
  }
}

/* -------------------- ACCOUNT-SPECIFIC HISTORY -------------------- */

function readHistory() {
  return historyItems;
}

function getHistoryKey() {
  if (!currentHistoryUserId) return null;

  return HISTORY_KEY_PREFIX +
    encodeURIComponent(currentHistoryUserId);
}

function activateUserHistory(user) {
  /*
   * Use a stable account ID if the backend returns one.
   * Otherwise fall back to username or name.
   */
  const identity =
    user?.id ??
    user?.userId ??
    user?.username ??
    user?.name;

  if (
    identity === undefined ||
    identity === null ||
    !String(identity).trim()
  ) {
    deactivateUserHistory();
    return;
  }

  const nextIdentity = String(identity)
    .trim()
    .toLowerCase();

  if (currentHistoryUserId !== nextIdentity) {
    currentHistoryUserId = nextIdentity;
    historyItems = [];
    latestReport = null;

    if (results) {
      results.hidden = true;
    }
  }

  loadHistory();
}

function deactivateUserHistory() {
  currentHistoryUserId = null;
  historyItems = [];
  latestReport = null;

  if (results) {
    results.hidden = true;
  }

  renderHistory();
}

function loadHistory() {
  const key = getHistoryKey();

  // Never display history before identifying the logged-in user.
  if (!key) {
    historyItems = [];
    renderHistory();
    return;
  }

  try {
    const stored = localStorage.getItem(key);
    const parsed = stored ? JSON.parse(stored) : [];

    historyItems = Array.isArray(parsed)
      ? parsed.slice(0, MAX_HISTORY)
      : [];
  } catch (error) {
    console.error(
      "Could not load this user's history:",
      error
    );

    historyItems = [];
  }

  renderHistory();
}

function writeHistory(items) {
  const key = getHistoryKey();

  // Prevent saving history without an identified account.
  if (!key) {
    historyItems = [];
    renderHistory();

    setStatus(
      "Please sign in before saving analysis history.",
      "error"
    );

    return;
  }

  historyItems = Array.isArray(items)
    ? items.slice(0, MAX_HISTORY)
    : [];

  try {
    localStorage.setItem(
      key,
      JSON.stringify(historyItems)
    );

    renderHistory();
  } catch (error) {
    console.error("History save failed:", error);

    setStatus(
      "Could not save history. Check available browser storage.",
      "error"
    );
  }
}

/* -------------------- RESUME UPLOAD -------------------- */

function validateFile(file) {
  if (!file) {
    setStatus(
      "Please select your resume first.",
      "error"
    );

    return false;
  }

  const extension = file.name
    .split(".")
    .pop()
    .toLowerCase();

  if (!["pdf", "docx", "txt"].includes(extension)) {
    setStatus(
      "Unsupported file. Select a PDF, DOCX, or TXT file.",
      "error"
    );

    return false;
  }

  if (!file.size) {
    setStatus(
      "The selected file is empty.",
      "error"
    );

    return false;
  }

  if (file.size > MAX_FILE_SIZE) {
    setStatus(
      "Maximum file size is 10 MB. Choose a smaller file.",
      "error"
    );

    return false;
  }

  return true;
}

function setSelectedFile(file) {
  if (!validateFile(file)) return;

  selectedResume = file;

  if (selectedFileBox) {
    selectedFileBox.hidden = false;
  }

  if (uploadTitle) {
    uploadTitle.textContent = file.name;
  }

  if (uploadSubtitle) {
    uploadSubtitle.textContent =
      `${(file.size / 1024).toFixed(1)} KB · Ready to analyze`;
  }

  uploadZone?.classList.add("file-selected");

  setStatus(
    "Resume selected. Add a job description, then analyze.",
    "success"
  );
}

function resetUpload() {
  selectedResume = null;

  if (resumeFile) {
    resumeFile.value = "";
  }

  if (selectedFileBox) {
    selectedFileBox.hidden = true;
  }

  if (uploadTitle) {
    uploadTitle.textContent = "No file selected";
  }

  if (uploadSubtitle) {
    uploadSubtitle.textContent = "Choose a resume to continue";
  }

  uploadZone?.classList.remove(
    "file-selected",
    "drag-over"
  );
}

function initializeUpload() {
  resumeFile?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];

    if (file) {
      setSelectedFile(file);
    }
  });

  removeFileButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    resetUpload();
    setStatus("Resume removed.");
  });

  uploadZone?.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target === uploadZone
    ) {
      event.preventDefault();
      resumeFile?.click();
    }
  });

  ["dragenter", "dragover"].forEach((name) => {
    uploadZone?.addEventListener(name, (event) => {
      event.preventDefault();
      uploadZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((name) => {
    uploadZone?.addEventListener(name, (event) => {
      event.preventDefault();
      uploadZone.classList.remove("drag-over");
    });
  });

  uploadZone?.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];

    if (!file || !validateFile(file)) return;

    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      resumeFile.files = dataTransfer.files;
    } catch (error) {
      console.warn(
        "Could not assign dropped file:",
        error
      );
    }

    setSelectedFile(file);
  });
}

/* -------------------- RESUME TEXT EXTRACTION -------------------- */

async function extractResumeText(file) {
  const extension = file.name
    .split(".")
    .pop()
    .toLowerCase();

  if (extension === "txt") {
    const text = await file.text();

    if (!text.trim()) {
      throw new Error(
        "The selected text file is empty."
      );
    }

    return text;
  }

  if (extension === "pdf") {
    if (!window.pdfjsLib) {
      throw new Error(
        "PDF reader did not load. Refresh the page and try again."
      );
    }

    const pdf = await pdfjsLib.getDocument({
      data: await file.arrayBuffer()
    }).promise;

    const pages = [];

    for (
      let pageNumber = 1;
      pageNumber <= pdf.numPages;
      pageNumber++
    ) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      pages.push(
        content.items.map((item) => item.str).join(" ")
      );
    }

    const text = pages.join("\n");

    if (!text.trim()) {
      throw new Error(
        "No selectable text was found. Scanned PDFs may require OCR."
      );
    }

    return text;
  }

  if (extension === "docx") {
    if (!window.mammoth) {
      throw new Error(
        "DOCX reader did not load. Refresh the page and try again."
      );
    }

    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer()
    });

    if (!result.value.trim()) {
      throw new Error(
        "No readable text was found in this DOCX file."
      );
    }

    return result.value;
  }

  throw new Error("Unsupported file type.");
}

/* -------------------- REPORT DISPLAY -------------------- */

function addListItems(element, values, emptyText) {
  if (!element) return;

  element.replaceChildren();

  const items = Array.isArray(values) ? values : [];

  if (!items.length) {
    const listItem = document.createElement("li");
    listItem.textContent = emptyText;
    element.appendChild(listItem);
    return;
  }

  items.forEach((value) => {
    const listItem = document.createElement("li");

    if (typeof value === "string") {
      listItem.textContent = value;
    } else {
      listItem.textContent = [
        value.name,
        value.description
      ].filter(Boolean).join(" — ");
    }

    element.appendChild(listItem);
  });
}

function renderReport(report) {
  latestReport = report;

  if (results) {
    results.hidden = false;
  }

  const score = Math.max(
    0,
    Math.min(100, Number(report.score) || 0)
  );

  if (scoreNumber) {
    scoreNumber.replaceChildren();

    const number = document.createTextNode(
      String(score)
    );

    const percent = document.createElement("span");
    percent.textContent = "%";

    scoreNumber.append(number, percent);
  }

  if (scoreRing) {
    scoreRing.style.setProperty(
      "--score-angle",
      `${score * 3.6}deg`
    );

    scoreRing.setAttribute(
      "aria-label",
      `AI estimated match score ${score}%`
    );
  }

  if (scoreMeterFill) {
    scoreMeterFill.style.width = `${score}%`;
  }

  setText(
    "scoreDescription",
    report.overview ||
      "AI-assisted comparison of the resume and job requirements."
  );

  setText(
    "matchScore",
    `AI-estimated job match: ${score}%`
  );

  setText(
    "matchedCount",
    (report.matchedSkills || []).length
  );

  setText(
    "missingCount",
    (report.missingSkills || []).length
  );

  setText(
    "jobSkillCount",
    (report.requiredSkills || []).length
  );

  if (coverageBar) {
    coverageBar.style.width = `${score}%`;
  }

  setText(
    "coverageText",
    `${score}% estimated alignment with the requirements supplied.`
  );

  addListItems(
    matchingSkills,
    report.matchedSkills,
    "No matching skills were identified."
  );

  addListItems(
    missingSkills,
    report.missingSkills,
    "No clear skill gaps were identified. Review the job requirements carefully."
  );

  const advice = [
    ...(report.recommendations || []).map((item) =>
      typeof item === "string"
        ? item
        : `${item.title || "Recommendation"}: ${item.description || ""}`
    ),

    ...(report.toolsToLearn || []).map((item) =>
      typeof item === "string"
        ? `Tool or skill to learn: ${item}`
        : `Learn ${item.name}: ${item.why || item.description || ""}`
    ),

    ...(report.resumeImprovements || []).map((item) =>
      typeof item === "string"
        ? item
        : `${item.section || "Resume"}: ${item.suggestion || item.description || ""}`
    )
  ];

  addListItems(
    suggestions,
    advice,
    "No extra recommendations were returned."
  );

  const subtitle = $("resultsSubtitle");

  if (subtitle) {
    subtitle.textContent =
      `${report.jobTitle || "Target role"} · ` +
      `${report.fileName || "Resume"} · ${formatDate(report.createdAt)}`;
  }

  results?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

/* -------------------- HISTORY DISPLAY -------------------- */

function renderHistory() {
  if (!historyList) return;

  const items = readHistory();

  if (historyBadge) {
    historyBadge.textContent = String(items.length);
  }

  if (emptyHistory) {
    emptyHistory.hidden = items.length > 0;
  }

  historyList.replaceChildren();

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "history-item";

    const details = document.createElement("div");
    details.className = "history-item-details";

    const title = document.createElement("strong");
    title.textContent = item.jobTitle || "Resume analysis";

    const meta = document.createElement("small");
    meta.textContent =
      `${item.fileName || "Resume"} · ${formatDate(item.createdAt)} · ${item.score ?? 0}%`;

    details.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "history-item-actions";

    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "button button-secondary";
    viewButton.textContent = "View";

    viewButton.addEventListener("click", () => {
      renderReport(item);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button button-quiet";
    deleteButton.textContent = "Delete";

    deleteButton.setAttribute(
      "aria-label",
      `Delete analysis for ${item.jobTitle || item.fileName || "this report"}`
    );

    deleteButton.addEventListener("click", () => {
      if (!window.confirm("Delete this analysis from history?")) {
        return;
      }

      writeHistory(
        readHistory().filter(
          (savedItem) => savedItem.id !== item.id
        )
      );

      if (latestReport?.id === item.id) {
        latestReport = null;

        if (results) {
          results.hidden = true;
        }
      }

      setStatus(
        "Selected history item deleted.",
        "success"
      );
    });

    actions.append(viewButton, deleteButton);
    card.append(details, actions);
    historyList.appendChild(card);
  });
}

/* -------------------- PDF DOWNLOAD -------------------- */

function downloadPDF() {
  if (!latestReport) {
    setStatus(
      "Run an analysis before downloading a report.",
      "error"
    );

    return;
  }

  if (!window.jspdf?.jsPDF) {
    setStatus(
      "PDF download library did not load. Check your internet connection and refresh.",
      "error"
    );

    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    unit: "mm",
    format: "a4"
  });

  const left = 16;
  const width = 178;
  let y = 18;

  function add(label, value) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);

    const heading = doc.splitTextToSize(label, width);

    doc.text(heading, left, y);
    y += heading.length * 5 + 1;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    const lines = doc.splitTextToSize(
      String(value || "Not provided"),
      width
    );

    lines.forEach((line) => {
      if (y > 275) {
        doc.addPage();
        y = 18;
      }

      doc.text(line, left, y);
      y += 4.5;
    });

    y += 3;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);

  doc.text(
    "ResumeIQ — AI Resume Analysis",
    left,
    y
  );

  y += 10;

  add("Target role", latestReport.jobTitle);
  add("Resume", latestReport.fileName);

  add(
    "Estimated match score",
    `${latestReport.score}% (AI-generated estimate; not a hiring prediction)`
  );

  add("Overview", latestReport.overview);

  add(
    "Matched skills",
    (latestReport.matchedSkills || []).join(", ")
  );

  add(
    "Missing / review skills",
    (latestReport.missingSkills || []).join(", ")
  );

  add(
    "Required skills detected",
    (latestReport.requiredSkills || []).join(", ")
  );

  add(
    "Tools and skills to learn",
    (latestReport.toolsToLearn || [])
      .map((item) =>
        typeof item === "string"
          ? item
          : `${item.name}: ${item.why || item.description || ""}`
      )
      .join("\n")
  );

  add(
    "Recommendations",
    (latestReport.recommendations || [])
      .map((item) =>
        typeof item === "string"
          ? item
          : `${item.title || ""}: ${item.description || ""}`
      )
      .join("\n")
  );

  add(
    "Resume improvements",
    (latestReport.resumeImprovements || [])
      .map((item) =>
        typeof item === "string"
          ? item
          : `${item.section || ""}: ${item.suggestion || item.description || ""}`
      )
      .join("\n")
  );

  add("Created", formatDate(latestReport.createdAt));

  doc.save(
    `ResumeIQ_Report_${new Date().toISOString().slice(0, 10)}.pdf`
  );
}

/* -------------------- AI ANALYSIS -------------------- */

async function analyze(event) {
  event.preventDefault();

  if (!currentHistoryUserId) {
    setStatus(
      "Please sign in before analyzing a resume.",
      "error"
    );
    return;
  }

  if (!selectedResume && resumeFile?.files?.[0]) {
    selectedResume = resumeFile.files[0];
  }

  if (!validateFile(selectedResume)) return;

  const description = jobDescription?.value.trim() || "";

  if (description.length < 30) {
    setStatus(
      "Please paste a more complete job description (at least 30 characters).",
      "error"
    );

    jobDescription?.focus();
    return;
  }

  analyzeButton.disabled = true;

  const originalButtonHTML = analyzeButton.innerHTML;
  analyzeButton.textContent = "Analyzing with AI…";

  setStatus("Reading your resume…");

  try {
    const resumeText = await extractResumeText(selectedResume);

    if (resumeText.length > 45000) {
      throw new Error(
        "The extracted resume text is unusually long. Please use a shorter resume file."
      );
    }

    setStatus(
      "AI is comparing your resume with the job description. This may take a moment…"
    );

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({
        resumeText,
        jobTitle: jobTitle?.value.trim() || "",
        jobDescription: description,
        fileName: selectedResume.name
      })
    });

    let payload;

    try {
      payload = await response.json();
    } catch {
      throw new Error(
        "The server returned an unreadable response. Check that the backend is running."
      );
    }

    if (!response.ok) {
      throw new Error(
        payload.error || `Analysis failed (${response.status}).`
      );
    }

    /* SQL false-negative correction */

    const normalizeSkill = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9+#.]+/g, " ")
        .trim();

    const isSqlSkill = (value) =>
      /\bsql\b|structured query language|\bmysql\b|\bpostgresql\b|\bpostgres\b|\bsqlite\b|microsoft sql server/i
        .test(String(value || ""));

    const extractedResumeText = resumeText.toLowerCase();

    const resumeHasSql =
      /\bsql\b/i.test(extractedResumeText) ||
      /\bstructured query language\b/i.test(extractedResumeText) ||
      /\bmysql\b/i.test(extractedResumeText) ||
      /\bpostgresql\b/i.test(extractedResumeText) ||
      /\bpostgres\b/i.test(extractedResumeText) ||
      /\bsqlite\b/i.test(extractedResumeText) ||
      /microsoft sql server/i.test(extractedResumeText);

    const requiredSkills = Array.isArray(payload.requiredSkills)
      ? [...payload.requiredSkills]
      : [];

    let matchedSkills = Array.isArray(payload.matchedSkills)
      ? [...payload.matchedSkills]
      : [];

    let missingSkills = Array.isArray(payload.missingSkills)
      ? [...payload.missingSkills]
      : [];

    if (resumeHasSql) {
      const requiredSqlSkills = requiredSkills.filter(isSqlSkill);

      if (requiredSqlSkills.length > 0) {
        missingSkills = missingSkills.filter(
          (skill) => !isSqlSkill(skill)
        );

        for (const skill of requiredSqlSkills) {
          const alreadyMatched = matchedSkills.some(
            (item) =>
              normalizeSkill(item) === normalizeSkill(skill)
          );

          if (!alreadyMatched) {
            matchedSkills.push(skill);
          }
        }
      } else {
        missingSkills = missingSkills.filter(
          (skill) => !isSqlSkill(skill)
        );
      }
    }

    const report = {
      id: makeId(),
      fileName: selectedResume.name,
      jobTitle:
        payload.jobTitle ||
        jobTitle?.value.trim() ||
        "Target role",
      createdAt: new Date().toISOString(),
      score: payload.score,
      overview: payload.overview,
      matchedSkills,
      missingSkills,
      requiredSkills,
      toolsToLearn: payload.toolsToLearn || [],
      recommendations: payload.recommendations || [],
      resumeImprovements: payload.resumeImprovements || []
    };

    renderReport(report);

    writeHistory([
      report,
      ...readHistory().filter(
        (item) => item.id !== report.id
      )
    ]);

    setStatus(
      "AI analysis completed and saved to this account's browser history.",
      "success"
    );
  } catch (error) {
    console.error(error);

    setStatus(
      error.message || "Something went wrong during analysis.",
      "error"
    );
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.innerHTML = originalButtonHTML;
  }
}

/* -------------------- RESET FORM -------------------- */

function resetForm() {
  resumeForm?.reset();
  resetUpload();

  if (results) {
    results.hidden = true;
  }

  latestReport = null;

  setStatus("Ready when you are.");

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

/* -------------------- ANALYZER INITIALIZATION -------------------- */

function initialize() {
  initializeUpload();

  resumeForm?.addEventListener("submit", analyze);
  downloadButton?.addEventListener("click", downloadPDF);
  resetButton?.addEventListener("click", resetForm);

  clearHistoryButton?.addEventListener("click", () => {
    const items = readHistory();

    if (!currentHistoryUserId) {
      setStatus(
        "Please sign in to view your history.",
        "error"
      );
      return;
    }

    if (!items.length) {
      setStatus("History is already empty.");
      return;
    }

    if (
      !window.confirm(
        "Delete all saved analyses for your account in this browser?"
      )
    ) {
      return;
    }

    writeHistory([]);

    setStatus(
      "Your account's local history has been cleared.",
      "success"
    );
  });

  jobDescription?.addEventListener("input", () => {
    setText(
      "characterCount",
      `${jobDescription.value.length} characters`
    );
  });

  const fileInfo = $("fileInfo");

  if (fileInfo) {
    fileInfo.textContent =
      "Your resume text is sent to the configured AI provider through the backend for analysis. Analysis history is separated by account in this browser.";
  }

  document.querySelector(".privacy-note")?.replaceChildren(
    document.createTextNode(
      "Resume text and the job description are sent to the configured AI provider through the backend. Analysis history is stored locally in this browser and separated by account identity."
    )
  );

  // Do not load history here.
  // It is loaded only after the authenticated user is identified.
}

/* -------------------- ACCOUNT LOGIN / SIGNUP -------------------- */

(() => {
  const byId = (id) => document.getElementById(id);

  const authPage = byId("authPage");
  const appContent = byId("appContent");
  const loginForm = byId("loginForm");
  const signupForm = byId("signupForm");
  const loginTab = byId("loginTab");
  const signupTab = byId("signupTab");
  const authHeading = byId("authHeading");
  const authDescription = byId("authDescription");
  const authMessage = byId("authMessage");

  function showAuthMessage(message, type = "") {
    if (!authMessage) return;

    authMessage.textContent = message;
    authMessage.className =
      `auth-message${type ? ` ${type}` : ""}`;
  }

  function setAuthMode(mode) {
    const signup = mode === "signup";

    if (loginForm) {
      loginForm.hidden = signup;
    }

    if (signupForm) {
      signupForm.hidden = !signup;
    }

    loginTab?.classList.toggle("active", !signup);
    signupTab?.classList.toggle("active", signup);

    loginTab?.setAttribute(
      "aria-selected",
      String(!signup)
    );

    signupTab?.setAttribute(
      "aria-selected",
      String(signup)
    );

    if (authHeading) {
      authHeading.textContent = signup
        ? "Create your account"
        : "Welcome back";
    }

    if (authDescription) {
      authDescription.textContent = signup
        ? "Create an account to open your ResumeIQ workspace."
        : "Sign in to access your ResumeIQ workspace.";
    }

    showAuthMessage("");
  }

  function showWorkspace(user) {
    activateUserHistory(user);

    if (authPage) {
      authPage.hidden = true;
    }

    if (appContent) {
      appContent.hidden = false;
    }

    let actions = byId("accountActions");

    if (!actions) {
      actions = document.createElement("div");
      actions.id = "accountActions";
      actions.className = "account-actions";

      const header = appContent?.querySelector(".site-header");

      if (header) {
        header.insertAdjacentElement("afterend", actions);
      }
    }

    const label = document.createElement("span");

    label.textContent =
      `Signed in${user?.name ? ` as ${user.name}` : ""}`;

    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.textContent = "Log out";

    logoutButton.addEventListener("click", async () => {
      logoutButton.disabled = true;

      try {
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin"
        });

        if (!response.ok) {
          throw new Error("Logout request failed.");
        }

        // Clear the visible history and report before showing login.
        deactivateUserHistory();

        if (appContent) {
          appContent.hidden = true;
        }

        if (authPage) {
          authPage.hidden = false;
        }

        loginForm?.reset();
        signupForm?.reset();

        setAuthMode("login");

        showAuthMessage(
          "You have been logged out.",
          "success"
        );

        actions.remove();
      } catch (error) {
        console.error(error);

        showAuthMessage(
          "Could not log out. Please try again."
        );

        logoutButton.disabled = false;
      }
    });

    actions.replaceChildren(label, logoutButton);
  }

  async function sendAuthRequest(endpoint, form, submitText) {
    const button = form.querySelector(
      'button[type="submit"]'
    );

    const originalText = button.textContent;

    button.disabled = true;
    button.textContent = submitText;

    showAuthMessage("");

    try {
      const formData = new FormData(form);
      const formValues = Object.fromEntries(
        formData.entries()
      );

      const body = {
        name: String(formValues.name || "").trim(),
        password: String(formValues.password || "")
      };

      if (!body.name) {
        throw new Error("Please enter your name.");
      }

      if (body.name.length > 80) {
        throw new Error(
          "Name must be 80 characters or fewer."
        );
      }

      if (body.password.length < 8) {
        throw new Error(
          "Password must contain at least 8 characters."
        );
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify(body)
      });

      let payload = {};

      try {
        payload = await response.json();
      } catch {
        // Use the HTTP status if the response isn't JSON.
      }

      if (!response.ok) {
        throw new Error(
          payload.error ||
          payload.message ||
          `Request failed (${response.status}).`
        );
      }

      const user =
        payload.user ||
        payload.account || {
          name: body.name
        };

      showWorkspace(user);
      form.reset();
    } catch (error) {
      console.error("Authentication error:", error);

      showAuthMessage(
        error.message ||
        "Could not connect to the server. Make sure the backend is running."
      );
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  loginTab?.addEventListener("click", () => {
    setAuthMode("login");
  });

  signupTab?.addEventListener("click", () => {
    setAuthMode("signup");
  });

  loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!loginForm.reportValidity()) return;

    sendAuthRequest(
      "/api/auth/login",
      loginForm,
      "Logging in…"
    );
  });

  signupForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!signupForm.reportValidity()) return;

    const password =
      byId("signupPassword")?.value || "";

    const confirmPassword =
      byId("signupConfirmPassword")?.value || "";

    if (password.length < 8) {
      showAuthMessage(
        "Use a password with at least 8 characters."
      );
      return;
    }

    if (password !== confirmPassword) {
      showAuthMessage("Passwords do not match.");

      byId("signupConfirmPassword")?.focus();
      return;
    }

    sendAuthRequest(
      "/api/auth/signup",
      signupForm,
      "Creating account…"
    );
  });

  document.addEventListener(
    "DOMContentLoaded",
    async () => {
      setAuthMode("login");

      if (appContent) {
        appContent.hidden = true;
      }

      if (authPage) {
        authPage.hidden = false;
      }

      try {
        const response = await fetch("/api/auth/me", {
          credentials: "same-origin"
        });

        if (!response.ok) return;

        const payload = await response.json();

        if (
          payload.authenticated ||
          payload.user ||
          payload.account
        ) {
          const user =
            payload.user ||
            payload.account ||
            null;

          showWorkspace(user);
        }
      } catch (error) {
        console.error(
          "Session check failed:",
          error
        );

        showAuthMessage(
          "Cannot reach the login server. Start the app using npm.cmd start, then refresh."
        );
      }
    }
  );
})();

/* Start analyzer functionality after the page loads. */
document.addEventListener(
  "DOMContentLoaded",
  initialize
);