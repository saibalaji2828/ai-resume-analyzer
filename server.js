import "dotenv/config";

import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import bcrypt from "bcryptjs";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const isProduction = process.env.NODE_ENV === "production";

if (
  isProduction &&
  (!process.env.DATABASE_URL ||
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32)
) {
  throw new Error(
    "Set DATABASE_URL and a SESSION_SECRET of at least 32 characters in Vercel Environment Variables."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: isProduction ? 5 : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const PgSessionStore = connectPgSimple(session);

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new PgSessionStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    name: "resumeiq.sid",
    secret:
      process.env.SESSION_SECRET ||
      "local-development-only-secret-change-before-deployment-123456789",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);

let schemaReadyPromise;

async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_unique
        ON users (LOWER(name))
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS analyses (
          id TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          report_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS analyses_user_created_idx
        ON analyses (user_id, created_at DESC)
      `);
    })().catch((error) => {
      schemaReadyPromise = undefined;
      throw error;
    });
  }

  return schemaReadyPromise;
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in to continue."
    });
  }

  next();
}

function safeUser(user) {
  return {
    id: String(user.id),
    name: user.name
  };
}

app.get(
  "/api/health",
  asyncRoute(async (_req, res) => {
    await ensureSchema();
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "ResumeIQ"
    });
  })
);

app.get("/api/auth/me", (req, res) => {
  res.json({
    user: req.session.user || null
  });
});

/* SIGNUP */
app.post(
  "/api/auth/signup",
  asyncRoute(async (req, res, next) => {
    await ensureSchema();

    const name = String(req.body?.name || "").trim();
    const password = String(req.body?.password || "");

    if (name.length < 2 || name.length > 60) {
      return res.status(400).json({
        error: "Name must be between 2 and 60 characters."
      });
    }

    if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) {
      return res.status(400).json({
        error: "Name contains unsupported characters."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Password must be 8–128 characters long."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let result;

    try {
      result = await pool.query(
        `INSERT INTO users (name, password_hash)
         VALUES ($1, $2)
         RETURNING id, name`,
        [name, passwordHash]
      );
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error:
            "That name already has an account. Please log in or choose another name."
        });
      }

      throw error;
    }

    const user = safeUser(result.rows[0]);

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = user;

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);

        res.status(201).json({ user });
      });
    });
  })
);

/* LOGIN */
app.post(
  "/api/auth/login",
  asyncRoute(async (req, res, next) => {
    await ensureSchema();

    const name = String(req.body?.name || "").trim();
    const password = String(req.body?.password || "");

    if (!name || !password) {
      return res.status(400).json({
        error: "Enter your name and password."
      });
    }

    const result = await pool.query(
      `SELECT id, name, password_hash
       FROM users
       WHERE LOWER(name) = LOWER($1)
       LIMIT 1`,
      [name]
    );

    const userRecord = result.rows[0];

    if (
      !userRecord ||
      !(await bcrypt.compare(password, userRecord.password_hash))
    ) {
      return res.status(401).json({
        error: "Incorrect name or password."
      });
    }

    const user = safeUser(userRecord);

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = user;

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);

        res.json({ user });
      });
    });
  })
);

/* LOGOUT */
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: "Could not log out. Please try again."
      });
    }

    res.clearCookie("resumeiq.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction
    });

    res.json({ ok: true });
  });
});

/* SKILL ALIASES */
const SKILL_ALIASES = {
  JavaScript: ["javascript", "java script"],
  TypeScript: ["typescript"],
  Python: ["python"],
  SQL: ["sql", "structured query language"],
  Excel: ["excel", "microsoft excel", "spreadsheets"],
  "Power BI": ["power bi", "powerbi"],
  Tableau: ["tableau"],
  "Data Analysis": ["data analysis", "data analytics"],
  Statistics: ["statistics", "statistical analysis"],
  "Machine Learning": ["machine learning"],
  "Deep Learning": ["deep learning"],
  HTML: ["html", "html5"],
  CSS: ["css", "css3"],
  React: ["react.js", "reactjs", "react"],
  "Node.js": ["node.js", "nodejs"],
  "Express.js": ["express.js", "expressjs"],
  Java: ["java"],
  "C++": ["c++", "cpp"],
  "C Programming": ["c programming", "c language"],
  Git: ["git"],
  GitHub: ["github"],
  MySQL: ["mysql"],
  PostgreSQL: ["postgresql", "postgres"],
  MongoDB: ["mongodb"],
  Cybersecurity: ["cybersecurity", "cyber security"],
  Networking: ["networking", "tcp/ip"],
  Linux: ["linux"],
  Wireshark: ["wireshark"],
  Nmap: ["nmap"],
  Metasploit: ["metasploit"],
  "Burp Suite": ["burp suite"],
  AWS: ["amazon web services", "aws"],
  Azure: ["microsoft azure", "azure"],
  Docker: ["docker"],
  Kubernetes: ["kubernetes"],
  Communication: ["communication"],
  "Problem Solving": ["problem solving", "problem-solving"],
  "Project Management": ["project management"],
  PowerPoint: ["powerpoint", "power point"],
  "Microsoft Word": ["microsoft word", "ms word"]
};

function hasPhrase(text, phrase) {
  const escaped = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

  return new RegExp(
    `(^|[^a-z0-9+#.])${escaped}($|[^a-z0-9+#.])`,
    "i"
  ).test(text);
}

/* LOCAL RESUME ANALYZER */
function analyzeLocally(
  resumeText,
  jobDescription,
  jobTitle,
  fileName
) {
  const resume = resumeText.toLowerCase();
  const job = jobDescription.toLowerCase();

  const requiredSkills = Object.entries(SKILL_ALIASES)
    .filter(([, aliases]) =>
      aliases.some((alias) => hasPhrase(job, alias))
    )
    .map(([skill]) => skill);

  const matchedSkills = requiredSkills.filter((skill) =>
    SKILL_ALIASES[skill].some((alias) =>
      hasPhrase(resume, alias)
    )
  );

  const missingSkills = requiredSkills.filter(
    (skill) => !matchedSkills.includes(skill)
  );

  const score = requiredSkills.length
    ? Math.round(
        (matchedSkills.length / requiredSkills.length) * 100
      )
    : 0;

  const toolsToLearn = missingSkills.map((name) => ({
    name,
    why:
      "This requirement was not clearly detected in your resume. Learn its fundamentals and practise with a small project if it is relevant to your target role.",
    priority:
      requiredSkills.indexOf(name) < 3 ? "High" : "Medium"
  }));

  const recommendations = [];

  if (!requiredSkills.length) {
    recommendations.push({
      title: "Add specific job requirements",
      description:
        "Include recognizable skills, tools, technologies and responsibilities in the job description."
    });
  }

  if (missingSkills.length) {
    recommendations.push({
      title: "Review missing skills",
      description:
        "Prioritize requirements relevant to your target role. A missing keyword does not prove you lack that skill."
    });
  }

  if (!/project|built|developed|created|implemented/i.test(resumeText)) {
    recommendations.push({
      title: "Show practical experience",
      description:
        "Add relevant projects and explain your contribution, tools used and outcomes."
    });
  }

  if (!/education|degree|university|college/i.test(resumeText)) {
    recommendations.push({
      title: "Check your education section",
      description:
        "Make relevant education and qualifications easy to find."
    });
  }

  if (!/experience|internship|employment/i.test(resumeText)) {
    recommendations.push({
      title: "Review your experience section",
      description:
        "If applicable, include internships, practical work or relevant projects."
    });
  }

  return {
    jobTitle: jobTitle.trim() || "Target role",
    fileName,
    score,
    overview:
      "Free keyword-based comparison of recognizable skills. It is not generative AI, an official ATS score or a prediction of hiring success.",
    requiredSkills,
    matchedSkills,
    missingSkills,
    toolsToLearn,
    recommendations,
    resumeImprovements: [
      {
        section: "Skills",
        suggestion:
          "Use clear skill names that accurately reflect your abilities."
      },
      {
        section: "Projects and experience",
        suggestion:
          "Explain your contribution, tools and results without inventing achievements."
      }
    ]
  };
}

/* ANALYZE ENDPOINT */
app.post("/api/analyze", requireAuth, (req, res) => {
  const {
    resumeText,
    jobTitle = "",
    jobDescription,
    fileName = "Resume"
  } = req.body || {};

  if (typeof resumeText !== "string" || resumeText.trim().length < 30) {
    return res.status(400).json({
      error: "Could not extract enough readable text from your resume."
    });
  }

  if (resumeText.length > 45000) {
    return res.status(413).json({
      error: "Resume text is too long. Please use a shorter resume."
    });
  }

  if (
    typeof jobDescription !== "string" ||
    jobDescription.trim().length < 30
  ) {
    return res.status(400).json({
      error: "Please provide a more complete job description."
    });
  }

  if (jobDescription.length > 30000) {
    return res.status(413).json({
      error: "Job description is too long."
    });
  }

  const report = analyzeLocally(
    resumeText.trim(),
    jobDescription.trim(),
    String(jobTitle).slice(0, 120),
    String(fileName).slice(0, 255)
  );

  report.id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  report.createdAt = new Date().toISOString();

  res.json(report);
});

/* GET USER-SPECIFIC HISTORY */
app.get(
  "/api/history",
  requireAuth,
  asyncRoute(async (req, res) => {
    await ensureSchema();

    const result = await pool.query(
      `SELECT report_json
       FROM analyses
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.session.user.id]
    );

    res.json({
      items: result.rows.map((row) =>
        typeof row.report_json === "string"
          ? JSON.parse(row.report_json)
          : row.report_json
      )
    });
  })
);

/* SAVE HISTORY */
app.post(
  "/api/history",
  requireAuth,
  asyncRoute(async (req, res) => {
    await ensureSchema();

    const report = req.body?.report;

    if (
      !report ||
      typeof report !== "object" ||
      !report.id ||
      !Number.isFinite(Number(report.score))
    ) {
      return res.status(400).json({
        error: "Invalid report."
      });
    }

    const id = String(report.id);
    const cleaned = {
      ...report,
      score: Math.max(
        0,
        Math.min(100, Math.round(Number(report.score)))
      )
    };

    const createdAt = cleaned.createdAt || new Date().toISOString();

    const existing = await pool.query(
      "SELECT user_id FROM analyses WHERE id = $1",
      [id]
    );

    if (
      existing.rows[0] &&
      String(existing.rows[0].user_id) !==
        String(req.session.user.id)
    ) {
      return res.status(409).json({
        error: "This report belongs to another account."
      });
    }

    await pool.query(
      `INSERT INTO analyses (id, user_id, report_json, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET
         report_json = EXCLUDED.report_json,
         created_at = EXCLUDED.created_at
       WHERE analyses.user_id = EXCLUDED.user_id`,
      [
        id,
        req.session.user.id,
        JSON.stringify(cleaned),
        createdAt
      ]
    );

    res.status(201).json({ ok: true });
  })
);

/* DELETE ONE HISTORY ITEM */
app.delete(
  "/api/history/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    await ensureSchema();

    const result = await pool.query(
      "DELETE FROM analyses WHERE id = $1 AND user_id = $2",
      [req.params.id, req.session.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Analysis not found in your account."
      });
    }

    res.json({ ok: true });
  })
);

/* DELETE ALL HISTORY FOR CURRENT USER */
app.delete(
  "/api/history",
  requireAuth,
  asyncRoute(async (req, res) => {
    await ensureSchema();

    await pool.query(
      "DELETE FROM analyses WHERE user_id = $1",
      [req.session.user.id]
    );

    res.json({ ok: true });
  })
);

/* SERVE EXISTING FRONTEND */
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found."
    });
  }

  if (req.method !== "GET") return next();

  res.sendFile(
    path.join(__dirname, "public", "index.html"),
    (error) => {
      if (error) next(error);
    }
  );
});

/* ERROR HANDLER */
app.use((error, _req, res, _next) => {
  console.error("Server error:", error.message || error);

  if (res.headersSent) return;

  res.status(500).json({
    error: "Unexpected server error. Please try again."
  });
});

/* VERCEL ENTRY POINT */
export default app;

/* LOCAL DEVELOPMENT */
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);

  app.listen(PORT, () => {
    console.log(`ResumeIQ running at http://localhost:${PORT}`);
    console.log("Authentication: Name + Password");
    console.log("Analysis: Free local keyword matching");
  });
}