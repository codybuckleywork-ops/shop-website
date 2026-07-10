import csv
import io
import sqlite3
import json
import os
from datetime import datetime
from flask import Flask, jsonify, request, render_template, g, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "dashboard.db")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

app = Flask(__name__)

DEFAULT_CONFIG = {
    "shop_name": "Production Dashboard",
    "location_name": "Hazel Green, AL",
    "lat": 34.9265,
    "lon": -86.5847,
    "google_calendar_connected": False
}

CATEGORIES = ["print", "laminate", "cut", "install", "material", "maintenance", "general"]
STAGES = ["design", "print", "laminate", "cut", "install", "complete"]
SUBSTRATES = [
    "acm", "coroplast", "aluminum", "pvc", "acrylic",
    "banner", "vinyl", "magnetic", "mdo", "other",
]


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            notes TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            due_date TEXT,
            priority TEXT DEFAULT 'medium',
            completed INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS equipment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            last_service TEXT,
            interval_days INTEGER DEFAULT 90,
            notes TEXT DEFAULT ''
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            resolved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer TEXT NOT NULL,
            job_name TEXT NOT NULL,
            stage TEXT DEFAULT 'design',
            due_date TEXT,
            install_date TEXT,
            priority TEXT DEFAULT 'medium',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            completed_at TEXT
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer TEXT NOT NULL,
            title TEXT NOT NULL,
            items TEXT DEFAULT '[]',
            tax_rate REAL DEFAULT 0,
            status TEXT DEFAULT 'draft',
            notes TEXT DEFAULT '',
            job_id INTEGER,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            on_hand REAL DEFAULT 0,
            unit TEXT DEFAULT 'sheets',
            reorder_at REAL DEFAULT 0,
            notes TEXT DEFAULT ''
        )
    """)
    db.commit()

    # Migrate older databases in place: add any missing job columns.
    existing = {r[1] for r in db.execute("PRAGMA table_info(jobs)").fetchall()}
    migrations = {
        "substrate": "ALTER TABLE jobs ADD COLUMN substrate TEXT DEFAULT ''",
        "on_hold": "ALTER TABLE jobs ADD COLUMN on_hold INTEGER DEFAULT 0",
        "stage_changed_at": "ALTER TABLE jobs ADD COLUMN stage_changed_at TEXT",
        "assigned_to": "ALTER TABLE jobs ADD COLUMN assigned_to TEXT DEFAULT ''",
    }
    for col, ddl in migrations.items():
        if col not in existing:
            db.execute(ddl)
    # Backfill stage_changed_at so aging starts counting from job creation.
    db.execute("UPDATE jobs SET stage_changed_at = created_at WHERE stage_changed_at IS NULL")

    # Tasks can optionally belong to a job (a per-job checklist item).
    existing_tasks = {r[1] for r in db.execute("PRAGMA table_info(tasks)").fetchall()}
    if "job_id" not in existing_tasks:
        db.execute("ALTER TABLE tasks ADD COLUMN job_id INTEGER")
    db.commit()

    # Seed with a couple of realistic starting rows if empty
    cur = db.execute("SELECT COUNT(*) FROM equipment")
    if cur.fetchone()[0] == 0:
        db.execute(
            "INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
            ("GFP 363TH Laminator", datetime.now().date().isoformat(), 90,
             "Check heater roller and blades for nicks")
        )
        db.commit()
    db.close()


def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/tasks", methods=["GET"])
def get_tasks():
    db = get_db()
    rows = db.execute("SELECT * FROM tasks ORDER BY completed ASC, due_date IS NULL, due_date ASC, priority DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/tasks", methods=["POST"])
def create_task():
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO tasks (title, notes, category, due_date, priority, completed, created_at, job_id) VALUES (?,?,?,?,?,0,?,?)",
        (
            title,
            data.get("notes", ""),
            data.get("category", "general") if data.get("category") in CATEGORIES else "general",
            data.get("due_date"),
            data.get("priority", "medium"),
            datetime.now().isoformat(),
            data.get("job_id"),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/tasks/<int:task_id>", methods=["PATCH"])
def update_task(task_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404

    fields = {}
    for key in ["title", "notes", "category", "due_date", "priority", "completed", "job_id"]:
        if key in data:
            fields[key] = data[key]

    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), task_id))
        db.commit()

    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db = get_db()
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    return "", 204


@app.route("/api/equipment", methods=["GET"])
def get_equipment():
    db = get_db()
    rows = db.execute("SELECT * FROM equipment ORDER BY last_service ASC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/equipment", methods=["POST"])
def create_equipment():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO equipment (name, last_service, interval_days, notes) VALUES (?,?,?,?)",
        (name, data.get("last_service"), data.get("interval_days", 90), data.get("notes", "")),
    )
    db.commit()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/equipment/<int:eq_id>", methods=["PATCH"])
def update_equipment(eq_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (eq_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["name", "last_service", "interval_days", "notes"]:
        if key in data:
            fields[key] = data[key]
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE equipment SET {set_clause} WHERE id = ?", (*fields.values(), eq_id))
        db.commit()
    row = db.execute("SELECT * FROM equipment WHERE id = ?", (eq_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/equipment/<int:eq_id>", methods=["DELETE"])
def delete_equipment(eq_id):
    db = get_db()
    db.execute("DELETE FROM equipment WHERE id = ?", (eq_id,))
    db.commit()
    return "", 204


@app.route("/api/jobs", methods=["GET"])
def get_jobs():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM jobs ORDER BY "
        "CASE stage WHEN 'complete' THEN 1 ELSE 0 END ASC, "
        "on_hold ASC, "
        "due_date IS NULL, due_date ASC, priority DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/jobs", methods=["POST"])
def create_job():
    data = request.get_json(force=True)
    customer = (data.get("customer") or "").strip()
    job_name = (data.get("job_name") or "").strip()
    if not customer or not job_name:
        return jsonify({"error": "customer and job_name are required"}), 400

    stage = data.get("stage", "design")
    if stage not in STAGES:
        return jsonify({"error": f"stage must be one of {STAGES}"}), 400

    substrate = data.get("substrate", "")
    if substrate and substrate not in SUBSTRATES:
        substrate = "other"

    now = datetime.now().isoformat()
    db = get_db()
    cur = db.execute(
        "INSERT INTO jobs (customer, job_name, stage, due_date, install_date, priority, notes, substrate, on_hold, assigned_to, created_at, completed_at, stage_changed_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            customer,
            job_name,
            stage,
            data.get("due_date"),
            data.get("install_date"),
            data.get("priority", "medium"),
            data.get("notes", ""),
            substrate,
            1 if data.get("on_hold") else 0,
            data.get("assigned_to", ""),
            now,
            now if stage == "complete" else None,
            now,
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM jobs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/jobs/<int:job_id>", methods=["PATCH"])
def update_job(job_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404

    if "stage" in data and data["stage"] not in STAGES:
        return jsonify({"error": f"stage must be one of {STAGES}"}), 400

    if "substrate" in data and data["substrate"] and data["substrate"] not in SUBSTRATES:
        data["substrate"] = "other"

    fields = {}
    for key in ["customer", "job_name", "stage", "due_date", "install_date", "priority", "notes", "substrate", "on_hold", "assigned_to"]:
        if key in data:
            fields[key] = data[key]

    # Track completion timestamp automatically as the job enters/leaves the
    # complete stage, rather than requiring the client to manage it.
    # Also stamp stage_changed_at whenever the stage actually changes, so the
    # board can show how long a job has been sitting at its current stage.
    if "stage" in fields:
        now = datetime.now().isoformat()
        fields["completed_at"] = now if fields["stage"] == "complete" else None
        if fields["stage"] != row["stage"]:
            fields["stage_changed_at"] = now

    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", (*fields.values(), job_id))
        db.commit()

    row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/jobs/<int:job_id>", methods=["DELETE"])
def delete_job(job_id):
    db = get_db()
    db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    # Remove the job's checklist items along with it.
    db.execute("DELETE FROM tasks WHERE job_id = ?", (job_id,))
    db.commit()
    return "", 204


QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"]


@app.route("/api/quotes", methods=["GET"])
def get_quotes():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM quotes ORDER BY "
        "CASE status WHEN 'accepted' THEN 1 WHEN 'declined' THEN 2 ELSE 0 END ASC, "
        "created_at DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/quotes", methods=["POST"])
def create_quote():
    data = request.get_json(force=True)
    customer = (data.get("customer") or "").strip()
    title = (data.get("title") or "").strip()
    if not customer or not title:
        return jsonify({"error": "customer and title are required"}), 400
    status = data.get("status", "draft")
    if status not in QUOTE_STATUSES:
        status = "draft"
    db = get_db()
    cur = db.execute(
        "INSERT INTO quotes (customer, title, items, tax_rate, status, notes, created_at) VALUES (?,?,?,?,?,?,?)",
        (
            customer,
            title,
            json.dumps(data.get("items", [])),
            data.get("tax_rate", 0) or 0,
            status,
            data.get("notes", ""),
            datetime.now().isoformat(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/quotes/<int:quote_id>", methods=["PATCH"])
def update_quote(quote_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    if "status" in data and data["status"] not in QUOTE_STATUSES:
        return jsonify({"error": f"status must be one of {QUOTE_STATUSES}"}), 400
    fields = {}
    for key in ["customer", "title", "tax_rate", "status", "notes"]:
        if key in data:
            fields[key] = data[key]
    if "items" in data:
        fields["items"] = json.dumps(data["items"])
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE quotes SET {set_clause} WHERE id = ?", (*fields.values(), quote_id))
        db.commit()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/quotes/<int:quote_id>", methods=["DELETE"])
def delete_quote(quote_id):
    db = get_db()
    db.execute("DELETE FROM quotes WHERE id = ?", (quote_id,))
    db.commit()
    return "", 204


@app.route("/api/quotes/<int:quote_id>/convert", methods=["POST"])
def convert_quote(quote_id):
    """Accept a quote and spin it straight into a job at the design stage."""
    db = get_db()
    row = db.execute("SELECT * FROM quotes WHERE id = ?", (quote_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    if row["job_id"]:
        job = db.execute("SELECT * FROM jobs WHERE id = ?", (row["job_id"],)).fetchone()
        if job:
            return jsonify(dict(job))

    now = datetime.now().isoformat()
    cur = db.execute(
        "INSERT INTO jobs (customer, job_name, stage, due_date, install_date, priority, notes, substrate, on_hold, assigned_to, created_at, completed_at, stage_changed_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            row["customer"],
            row["title"],
            "design",
            None,
            None,
            "medium",
            (row["notes"] or "") + f"\n(From quote Q-{row['id']:04d})",
            "",
            0,
            "",
            now,
            None,
            now,
        ),
    )
    db.execute("UPDATE quotes SET status = 'accepted', job_id = ? WHERE id = ?", (cur.lastrowid, quote_id))
    db.commit()
    job = db.execute("SELECT * FROM jobs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(job)), 201


@app.route("/api/export/jobs.csv", methods=["GET"])
def export_jobs_csv():
    db = get_db()
    rows = db.execute("SELECT * FROM jobs ORDER BY id ASC").fetchall()
    out = io.StringIO()
    writer = csv.writer(out)
    cols = ["id", "customer", "job_name", "stage", "substrate", "assigned_to",
            "priority", "on_hold", "due_date", "install_date", "notes",
            "created_at", "stage_changed_at", "completed_at"]
    writer.writerow(cols)
    for r in rows:
        d = dict(r)
        writer.writerow([d.get(c, "") for c in cols])
    return Response(
        out.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=jobs.csv"},
    )


@app.route("/api/materials", methods=["GET"])
def get_materials():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM materials ORDER BY "
        "CASE WHEN reorder_at > 0 AND on_hand <= reorder_at THEN 0 ELSE 1 END ASC, "
        "name ASC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/materials", methods=["POST"])
def create_material():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO materials (name, on_hand, unit, reorder_at, notes) VALUES (?,?,?,?,?)",
        (
            name,
            data.get("on_hand", 0),
            data.get("unit", "sheets"),
            data.get("reorder_at", 0),
            data.get("notes", ""),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/materials/<int:mat_id>", methods=["PATCH"])
def update_material(mat_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (mat_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["name", "on_hand", "unit", "reorder_at", "notes"]:
        if key in data:
            fields[key] = data[key]
    if "on_hand" in fields:
        fields["on_hand"] = max(0, fields["on_hand"] or 0)
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE materials SET {set_clause} WHERE id = ?", (*fields.values(), mat_id))
        db.commit()
    row = db.execute("SELECT * FROM materials WHERE id = ?", (mat_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/materials/<int:mat_id>", methods=["DELETE"])
def delete_material(mat_id):
    db = get_db()
    db.execute("DELETE FROM materials WHERE id = ?", (mat_id,))
    db.commit()
    return "", 204


@app.route("/api/notes", methods=["GET"])
def get_notes():
    db = get_db()
    rows = db.execute("SELECT * FROM notes ORDER BY resolved ASC, created_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/notes", methods=["POST"])
def create_note():
    data = request.get_json(force=True)
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO notes (content, resolved, created_at) VALUES (?,0,?)",
        (content, datetime.now().isoformat()),
    )
    db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/api/notes/<int:note_id>", methods=["PATCH"])
def update_note(note_id):
    data = request.get_json(force=True)
    db = get_db()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = {}
    for key in ["content", "resolved"]:
        if key in data:
            fields[key] = data[key]
    if fields:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        db.execute(f"UPDATE notes SET {set_clause} WHERE id = ?", (*fields.values(), note_id))
        db.commit()
    row = db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return jsonify(dict(row))


@app.route("/api/notes/<int:note_id>", methods=["DELETE"])
def delete_note(note_id):
    db = get_db()
    db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    db.commit()
    return "", 204


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(load_config())


@app.route("/api/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(force=True)
    cfg = load_config()
    cfg.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
    save_config(cfg)
    return jsonify(cfg)


if __name__ == "__main__":
    init_db()
    load_config()
    # debug=False by default since this is meant to run continuously on a
    # self-hosted box. Set FLASK_DEBUG=1 in your shell if you want the
    # auto-reloader while making changes.
    debug_mode = os.environ.get("FLASK_DEBUG") == "1"
    app.run(host="0.0.0.0", port=5000, debug=debug_mode)
