#!/usr/bin/env python3
"""
generate_docx.py — Convert the DWA Database Guide into a styled Word document.

Usage:
    pip install python-docx
    python docs/database/generate_docx.py

Output:
    docs/database/DATABASE_GUIDE_EXPLAINED.docx
"""

from pathlib import Path
from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml
import re

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DOCX = SCRIPT_DIR / "DATABASE_GUIDE_EXPLAINED.docx"

# ── Helpers ──────────────────────────────────────────────────────────────────

def set_cell_shading(cell, color_hex: str):
    """Apply background shading to a table cell."""
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}" w:val="clear"/>')
    cell._tc.get_or_add_tcPr().append(shading)


def add_code_block(doc, text: str):
    """Add a code block with monospace font and grey background."""
    for i, line in enumerate(text.split("\n")):
        p = doc.add_paragraph()
        p.style = doc.styles["Normal"]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = Pt(14)
        p.paragraph_format.left_indent = Cm(1)
        run = p.add_run(line if line else " ")
        run.font.name = "Courier New"
        run.font.size = Pt(8.5)
        run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
        # Grey background via character shading
        rPr = run._r.get_or_add_rPr()
        shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="F0F0F0" w:val="clear"/>')
        rPr.append(shading)


def add_styled_table(doc, headers: list[str], rows: list[list[str]]):
    """Add a formatted table with header row."""
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = "Light Grid Accent 1"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    # Header row
    for j, h in enumerate(headers):
        cell = table.rows[0].cells[j]
        cell.text = ""
        p = cell.paragraphs[0]
        run = p.add_run(h)
        run.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_shading(cell, "2E5090")

    # Data rows
    for i, row_data in enumerate(rows):
        for j, val in enumerate(row_data):
            cell = table.rows[i + 1].cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            run = p.add_run(val)
            run.font.size = Pt(9)
            if i % 2 == 1:
                set_cell_shading(cell, "F5F7FA")

    return table


def add_inline_code(paragraph, text: str):
    """Add inline code (monospace) run to a paragraph."""
    run = paragraph.add_run(text)
    run.font.name = "Courier New"
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0xC0, 0x39, 0x2B)
    return run


def add_paragraph_with_formatting(doc, text: str, style="Normal", bold=False):
    """Add a paragraph, handling inline backtick code and bold markers."""
    p = doc.add_paragraph(style=style)
    # Split by backtick-delimited code
    parts = re.split(r'`([^`]+)`', text)
    for idx, part in enumerate(parts):
        if idx % 2 == 1:
            # Code part
            add_inline_code(p, part)
        else:
            # Handle **bold** markers
            bold_parts = re.split(r'\*\*([^*]+)\*\*', part)
            for bidx, bpart in enumerate(bold_parts):
                if bidx % 2 == 1:
                    run = p.add_run(bpart)
                    run.bold = True
                    run.font.size = Pt(10)
                else:
                    if bpart:
                        run = p.add_run(bpart)
                        run.font.size = Pt(10)
                        if bold:
                            run.bold = True
    return p


def add_bullet(doc, text: str, level: int = 0):
    """Add a bullet point, handling inline formatting."""
    p = add_paragraph_with_formatting(doc, text, style="List Bullet")
    p.paragraph_format.left_indent = Cm(1.5 + level * 1.0)
    return p


def add_numbered(doc, text: str):
    """Add a numbered list item."""
    p = add_paragraph_with_formatting(doc, text, style="List Number")
    return p


def add_page_numbers(doc):
    """Add page numbers to footer."""
    section = doc.sections[0]
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # PAGE field
    run = p.add_run()
    fldChar1 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>')
    run._r.append(fldChar1)
    run2 = p.add_run()
    instrText = parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> PAGE </w:instrText>')
    run2._r.append(instrText)
    run3 = p.add_run()
    fldChar2 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>')
    run3._r.append(fldChar2)
    run4 = p.add_run(" / ")
    run5 = p.add_run()
    fldChar3 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>')
    run5._r.append(fldChar3)
    run6 = p.add_run()
    instrText2 = parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> NUMPAGES </w:instrText>')
    run6._r.append(instrText2)
    run7 = p.add_run()
    fldChar4 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>')
    run7._r.append(fldChar4)


# ── Main Document Construction ───────────────────────────────────────────────

def build_document():
    doc = Document()

    # ── Document properties ──
    core = doc.core_properties
    core.title = "DWA Database Guide — Everything Explained Simply"
    core.author = "DWA Database Team"
    core.category = "Technical Documentation"

    # ── Page margins ──
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    # ══════════════════════════════════════════════════════════════════════════
    # TITLE PAGE
    # ══════════════════════════════════════════════════════════════════════════
    for _ in range(6):
        doc.add_paragraph("")

    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title_p.add_run("DWA Database Guide")
    run.font.size = Pt(36)
    run.bold = True
    run.font.color.rgb = RGBColor(0x2E, 0x50, 0x90)

    subtitle_p = doc.add_paragraph()
    subtitle_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = subtitle_p.add_run("Everything Explained Simply")
    run.font.size = Pt(20)
    run.font.color.rgb = RGBColor(0x5A, 0x5A, 0x5A)

    doc.add_paragraph("")

    desc_p = doc.add_paragraph()
    desc_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = desc_p.add_run("A beginner-friendly guide for the DWA development team.\nNo prior database experience required.")
    run.font.size = Pt(12)
    run.font.color.rgb = RGBColor(0x77, 0x77, 0x77)
    run.font.italic = True

    for _ in range(4):
        doc.add_paragraph("")

    team_p = doc.add_paragraph()
    team_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = team_p.add_run("DWA Database Team")
    run.font.size = Pt(14)
    run.bold = True

    date_p = doc.add_paragraph()
    date_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = date_p.add_run("November 2026")
    run.font.size = Pt(12)
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # TABLE OF CONTENTS
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("Table of Contents", level=1)

    toc_entries = [
        "1. Executive Summary",
        "2. Plain-English Glossary of Technical Terms",
        "3. The 14 Tables Explained in Plain English",
        "4. How the Medicine Catalogue Was Built",
        "5. How a Medicine Search Works Step-by-Step",
        "6. How to Defend This in Front of the Professor",
    ]
    for entry in toc_entries:
        p = doc.add_paragraph(entry, style="List Number")
        p.paragraph_format.space_after = Pt(4)

    # TOC field (Word will populate when user presses F9)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run("\n[Press F9 in Word to update the full Table of Contents field]\n")
    run.font.size = Pt(9)
    run.font.italic = True
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    # Insert TOC field
    p_toc = doc.add_paragraph()
    run_toc = p_toc.add_run()
    fldChar1 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="begin"/>')
    run_toc._r.append(fldChar1)
    run_toc2 = p_toc.add_run()
    instrText = parse_xml(f'<w:instrText {nsdecls("w")} xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>')
    run_toc2._r.append(instrText)
    run_toc3 = p_toc.add_run()
    fldChar2 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="separate"/>')
    run_toc3._r.append(fldChar2)
    run_toc4 = p_toc.add_run("(Table of Contents — right-click and select 'Update Field' in Word)")
    run_toc4.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    run_toc4.font.italic = True
    run_toc5 = p_toc.add_run()
    fldChar3 = parse_xml(f'<w:fldChar {nsdecls("w")} w:fldCharType="end"/>')
    run_toc5._r.append(fldChar3)

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 1: EXECUTIVE SUMMARY
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("1. Executive Summary", level=1)

    doc.add_heading("The Problem", level=2)

    add_paragraph_with_formatting(doc, "In Algeria today, patients face three major frustrations:")

    add_numbered(doc, "**You can't find your medicine.** You walk from pharmacy to pharmacy asking \"Do you have Doliprane?\" — sometimes visiting 5 or 6 pharmacies before finding it, or giving up entirely. There is no centralized system to check which pharmacy has what in stock.")
    add_numbered(doc, "**Pharmacies are flying blind.** Pharmacy owners don't know what medicines patients in their area are searching for. They can't see demand patterns, so they over-stock some products and under-stock others. There's no data-driven way to manage inventory.")
    add_numbered(doc, "**There is no online reservation system.** Even when a pharmacy has your medicine, by the time you arrive, someone else may have bought the last box. There's no way to hold a medicine remotely and pick it up later.")

    doc.add_heading("Our Solution: DWA", level=2)

    add_paragraph_with_formatting(doc, "DWA is a platform that connects Algerian patients with pharmacies. It solves all three problems:")

    add_bullet(doc, "**Patients** can search for any medicine, see which nearby pharmacies have it in stock (with real-time quantities and prices), and **reserve** it for pickup within 2–4 hours.")
    add_bullet(doc, "**Pharmacists** can manage their stock digitally, see what medicines people in their wilaya are searching for (demand analytics), and receive prescription requests.")
    add_bullet(doc, "**The database** is the brain that makes all of this work. It stores 5,425 official Algerian medicines, tracks pharmacy stock down to individual batches (with expiry dates), manages the reservation lifecycle, and uses GPS to find nearby pharmacies.")

    doc.add_heading("Why This Database Matters", level=2)

    add_paragraph_with_formatting(doc, "Every feature of DWA depends on data being stored correctly, consistently, and efficiently:")

    add_styled_table(doc,
        ["Feature", "Database Responsibility"],
        [
            ["Medicine search", "Fuzzy text matching + geographic filtering"],
            ["Stock availability", "Real-time calculation from batch quantities"],
            ["Reservations", "Concurrent-safe locking to prevent double-booking"],
            ["\"Pharmacy nearby\"", "PostGIS spatial queries with distance in meters"],
            ["Prescription upload", "Linking prescriptions to pharmacies in the same wilaya"],
            ["Demand analytics", "Logging searches to identify unmet medicine demand"],
            ["Rating system", "Auto-calculated averages via triggers"],
        ]
    )

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 2: GLOSSARY
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("2. Plain-English Glossary of Technical Terms", level=1)

    # PostgreSQL
    doc.add_heading("PostgreSQL", level=2)
    add_paragraph_with_formatting(doc, "**What it is:** PostgreSQL (often called \"Postgres\") is an open-source relational database management system (RDBMS). Think of it as a very sophisticated spreadsheet engine — but instead of Excel files, it stores data in structured tables with strict rules about what data is allowed.")
    add_paragraph_with_formatting(doc, "**How it differs from MySQL:** Both are relational databases, but PostgreSQL has more advanced features out of the box. It supports things like JSONB (storing flexible JSON data alongside structured data), PostGIS (geographic queries), custom types (ENUMs), and powerful triggers. MySQL is simpler and historically faster for basic read operations, but PostgreSQL is more feature-rich and standards-compliant.")
    add_paragraph_with_formatting(doc, "**Why we chose it:** Supabase — our hosting platform — runs on PostgreSQL. This gives us access to all of PostgreSQL's advanced features (JSONB, PostGIS, triggers, views) plus Supabase's extras (real-time subscriptions, auto-generated REST APIs, built-in authentication). We get a production-grade database with zero infrastructure management.")

    # PostGIS
    doc.add_heading("PostGIS", level=2)
    add_paragraph_with_formatting(doc, "**What it is:** PostGIS is an extension (a plugin) for PostgreSQL that adds GPS and geographic capabilities. Without PostGIS, PostgreSQL only understands numbers, text, and dates. With PostGIS, it understands locations on Earth.")
    add_paragraph_with_formatting(doc, "**How we use it:**")
    add_bullet(doc, "We store each pharmacy's location as `geography(Point, 4326)`. The \"Point\" means a single GPS coordinate (latitude, longitude). The \"4326\" is the SRID (Spatial Reference Identifier) — it tells PostGIS to use the WGS 84 coordinate system, the same system used by Google Maps and every GPS device.")
    add_bullet(doc, "`ST_DWithin(pharmacy.location, patient_point, 5000)` answers: \"Is this pharmacy within 5,000 meters (5 km) of the patient?\" It calculates the real-world distance on Earth's curved surface.")
    add_bullet(doc, "`ST_Distance(pharmacy.location, patient_point)` returns the exact distance in meters between two points.")
    add_paragraph_with_formatting(doc, "**Why this matters for DWA:** When a patient in Bab Ezzouar searches for Doliprane, we can instantly find all pharmacies within 5 km that have it in stock, sorted by distance. Without PostGIS, we'd have to calculate distances in our application code using the Haversine formula — which would be slower and couldn't use spatial indexes.")

    # ENUMs
    doc.add_heading("ENUMs", level=2)
    add_paragraph_with_formatting(doc, "**What it is:** An ENUM (enumeration) is a restricted set of allowed values for a column. Think of it like a dropdown menu in a form — you can only pick from the options listed.")
    add_paragraph_with_formatting(doc, "**Example from DWA:**")
    add_code_block(doc, "CREATE TYPE reservation_status AS ENUM (\n  'pending_payment',\n  'confirmed_held',\n  'ready_for_pickup',\n  'completed',\n  'expired',\n  'cancelled'\n);")
    add_paragraph_with_formatting(doc, "A reservation's status can ONLY be one of these 6 values. If your application code accidentally tries to insert `\"compelted\"` (a typo), the database will reject it with an error.")
    add_paragraph_with_formatting(doc, "**ENUMs we use in DWA:**")
    add_styled_table(doc,
        ["ENUM Name", "Allowed Values", "Used For"],
        [
            ["user_role", "patient, pharmacist, admin", "Who the user is"],
            ["reservation_status", "pending_payment, confirmed_held, ready_for_pickup, completed, expired, cancelled", "Where a reservation is in its lifecycle"],
            ["payment_status", "pending, succeeded, failed, refunded", "Payment state"],
            ["payment_purpose", "reservation_deposit, pro_plan", "What the payment is for"],
            ["alert_type", "back_in_stock, refill_reminder", "Type of notification"],
            ["verification_status", "pending, verified, rejected", "Pharmacist license review"],
        ]
    )

    # Triggers
    doc.add_heading("Triggers", level=2)
    add_paragraph_with_formatting(doc, "**What it is:** A trigger is an automatic function that fires (runs) when data changes in a table. You don't call it manually — the database calls it for you every time a specific event happens (INSERT, UPDATE, or DELETE).")
    add_paragraph_with_formatting(doc, "**Think of it like:** An automatic door sensor. You don't press a button to open the door — walking toward it triggers the sensor, which opens the door automatically. Similarly, when you update a reservation's status, a trigger automatically checks if the transition is valid.")
    add_paragraph_with_formatting(doc, "**Triggers we use in DWA:**")
    add_styled_table(doc,
        ["Trigger", "When It Fires", "What It Does"],
        [
            ["set_updated_at", "Any row is updated", "Automatically sets the updated_at column to the current time."],
            ["trg_reservation_status_machine", "Reservation status changes", "Enforces the state machine: you can go from pending_payment → confirmed_held, but NOT from completed → pending_payment."],
            ["trg_rating_only_completed", "A rating is inserted", "Checks that the reservation being rated has status = completed."],
            ["trg_recalc_pharmacy_rating", "A rating is inserted or updated", "Recalculates the pharmacy's rating_avg and rating_count from all its ratings."],
        ]
    )

    # Views
    doc.add_heading("Database Views", level=2)
    add_paragraph_with_formatting(doc, "**What it is:** A view is a virtual table. It doesn't store any data itself — it's a saved SQL query that runs every time you read from it. When you `SELECT * FROM v_pharmacy_stock_status`, PostgreSQL runs the underlying query and returns fresh results.")
    add_paragraph_with_formatting(doc, "**Why views are better than storing calculated data:**")
    add_paragraph_with_formatting(doc, "Imagine we stored a `stock_status` column directly in the `pharmacy_stock` table. Every time someone makes a reservation, cancels one, or a batch expires, we'd need to recalculate and update that column. If we forget even once, the status is wrong. With a view, the status is calculated on-the-fly every time:")
    add_code_block(doc, "available = total_quantity - reserved_quantity\n\nIf available = 0       → 'out_of_stock'\nIf available ≤ 5       → 'low_stock'\nIf available > 5       → 'in_stock'")
    add_paragraph_with_formatting(doc, "**Views we use in DWA:**")
    add_styled_table(doc,
        ["View", "What It Shows"],
        [
            ["v_pharmacy_stock_status", "For each stock batch: available quantity and stock status (in_stock / low_stock / out_of_stock)"],
            ["v_pharmacy_medicine_availability", "For each pharmacy × medicine combo: total available across all non-expired batches, cheapest price, and combined status"],
            ["v_unmet_demand", "Medicines people are searching for but can't find, grouped by wilaya"],
        ]
    )

    # Concurrency
    doc.add_heading("Concurrency & Row-Level Locking", level=2)
    add_paragraph_with_formatting(doc, "**The Problem (Race Condition):**")
    add_paragraph_with_formatting(doc, "Imagine there's exactly 1 box of Doliprane left at a pharmacy. Two patients — Alice and Bob — both click \"Reserve\" at the same instant. Without any protection:")
    add_numbered(doc, "Alice's request reads: \"1 box available\" → proceeds to reserve")
    add_numbered(doc, "Bob's request reads: \"1 box available\" → proceeds to reserve")
    add_numbered(doc, "Both reservations are created → but only 1 box exists! This is a **race condition**.")

    add_paragraph_with_formatting(doc, "**The Solution (Row-Level Locking):**")
    add_paragraph_with_formatting(doc, "Our `fn_create_reservation` function uses `SELECT ... FOR UPDATE`:")
    add_code_block(doc, "SELECT total_quantity, reserved_quantity\nFROM pharmacy_stock\nWHERE id = target_stock_id\nFOR UPDATE;  -- This locks the row")
    add_paragraph_with_formatting(doc, "Here's what happens now:")
    add_numbered(doc, "Alice's transaction runs first: `FOR UPDATE` locks the stock row")
    add_numbered(doc, "Bob's transaction tries to read the same row — it **waits** (the row is locked)")
    add_numbered(doc, "Alice's transaction reserves the box: `reserved_quantity` goes from 0 to 1")
    add_numbered(doc, "Alice's transaction commits → the lock is released")
    add_numbered(doc, "Bob's transaction gets the lock, reads: available = 1 - 1 = 0")
    add_numbered(doc, "Bob's transaction sees 0 available → raises an error: \"Not enough stock\"")
    add_paragraph_with_formatting(doc, "**No double-booking is possible.** The lock guarantees that only one transaction can modify the stock row at a time.")
    add_paragraph_with_formatting(doc, "`FOR UPDATE SKIP LOCKED` is a variation used in the batch expiry job (`fn_expire_due_reservations`). Instead of waiting for the lock, it skips rows that are currently locked. This prevents the expiry job from blocking patient reservations.")

    # GIN Indexes
    doc.add_heading("GIN Indexes (pg_trgm)", level=2)
    add_paragraph_with_formatting(doc, "**The Problem:** Patients make typos. They might type \"Dolipran\" instead of \"Doliprane\". A normal database search (`WHERE name = 'Dolipran'`) would return zero results.")
    add_paragraph_with_formatting(doc, "**How pg_trgm Works:**")
    add_paragraph_with_formatting(doc, "The `pg_trgm` extension breaks every word into overlapping 3-character chunks called trigrams:")
    add_code_block(doc, '"Doliprane" → {" d", " do", "dol", "oli", "lip", "ipr", "pra", "ran", "ane", "ne "}\n"Dolipran"  → {" d", " do", "dol", "oli", "lip", "ipr", "pra", "ran", "an "}')
    add_paragraph_with_formatting(doc, "Many trigrams are shared, so the similarity score is high. The GIN (Generalized Inverted Index) pre-computes and stores all trigrams for every medicine name. This makes fuzzy search fast (sub-300ms).")
    add_paragraph_with_formatting(doc, "**Our GIN Indexes:**")
    add_code_block(doc, "-- Fuzzy search on medicine commercial name\nCREATE INDEX idx_med_commercial_trgm ON medicines\n  USING gin (commercial_name gin_trgm_ops);\n\n-- Fuzzy search on medicine DCI (generic name)\nCREATE INDEX idx_med_dci_trgm ON medicines\n  USING gin (dci gin_trgm_ops);")

    # GiST Indexes
    doc.add_heading("GiST Indexes", level=2)
    add_paragraph_with_formatting(doc, "**The Problem:** Finding nearby pharmacies without spatial indexes requires calculating distance to EVERY pharmacy in the database — O(n) full scan.")
    add_paragraph_with_formatting(doc, "**How GiST Indexes Help:** GiST (Generalized Search Tree) indexes for spatial data divide the map into a hierarchy of regions. When searching for pharmacies within 5 km, the index eliminates entire regions that are too far away. Instead of checking 10,000 pharmacies, it might check only 50.")
    add_paragraph_with_formatting(doc, "**Our GiST Index:**")
    add_code_block(doc, "CREATE INDEX idx_pharmacy_location ON pharmacies USING gist (location);")

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 3: THE 14 TABLES
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("3. The 14 Tables Explained in Plain English", level=1)

    # ── Domain A ──
    doc.add_heading("Domain A: Users & License Verification (2 tables)", level=2)

    doc.add_heading("Table 1: users", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Every person who uses DWA — patients, pharmacists, and admins.")
    add_paragraph_with_formatting(doc, "**Analogy:** Think of it as the registration book at the front desk. Everyone who enters the building signs in here.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "A unique identifier for each user (auto-generated)"],
            ["email", "text", "Login email (must be unique)"],
            ["password_hash", "text", "The password, encrypted. We never store plain passwords."],
            ["role", "user_role ENUM", "Is this person a patient, pharmacist, or admin?"],
            ["full_name", "text", "Their full name"],
            ["phone", "text", "Phone number (optional)"],
            ["chifa_number", "char(18)", "CHIFA social security card number (optional, for patients)"],
            ["wilaya_code", "char(2)", "The 2-digit wilaya code (01 = Adrar, 16 = Alger, etc.)"],
            ["law_18_07_consent_at", "timestamptz", "When the user consented to data storage under Algeria's Personal Data Protection Law 18-07 (June 2018). Legally required."],
            ["created_at", "timestamptz", "When the account was created"],
            ["updated_at", "timestamptz", "Last modification time (auto-set by trigger)"],
        ]
    )

    doc.add_heading("Table 2: pharmacist_verifications", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** The review process when a pharmacist signs up. An admin must verify their professional license before they can manage a pharmacy.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like a job application review — the applicant submits their credentials, and HR reviews them.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["pharmacist_id", "UUID (FK → users)", "Which pharmacist is being verified"],
            ["document_url", "text", "URL of the uploaded license document"],
            ["status", "verification_status ENUM", "pending, verified, or rejected"],
            ["reviewed_by", "UUID (FK → users)", "Which admin reviewed it"],
            ["reviewed_at", "timestamptz", "When the review happened"],
            ["rejection_reason", "text", "Why it was rejected (required if rejected)"],
        ]
    )
    add_paragraph_with_formatting(doc, "**Key constraints:** pharmacist_id ≠ reviewed_by (no self-review). If rejected, rejection_reason must not be null.")

    # ── Domain B ──
    doc.add_heading("Domain B: Pharmacies, Catalogue & Batch Stock (5 tables)", level=2)

    doc.add_heading("Table 3: pharmacies", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Each physical pharmacy location in Algeria.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like a listing on Google Maps — name, address, location pin, hours, and reviews.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "Unique pharmacy identifier"],
            ["owner_id", "UUID (FK → users)", "The pharmacist who owns/manages this pharmacy"],
            ["name", "text", "Pharmacy name (e.g., \"Pharmacie El Afia\")"],
            ["address", "text", "Street address"],
            ["wilaya_code", "char(2)", "Which of Algeria's 58 wilayas"],
            ["commune", "text", "Which commune within the wilaya"],
            ["location", "geography(Point, 4326)", "GPS coordinates (PostGIS point)"],
            ["phone", "text", "Contact phone number"],
            ["is_active", "boolean", "Is this pharmacy currently operating on DWA?"],
            ["pro_plan_until", "timestamptz", "When the paid subscription expires"],
            ["rating_avg", "numeric(2,1)", "Average rating (auto-calculated by trigger)"],
            ["rating_count", "integer", "Number of ratings (auto-calculated by trigger)"],
        ]
    )
    add_paragraph_with_formatting(doc, "**Design note:** One pharmacist (`owner_id`) can own multiple pharmacies (chain). `rating_avg` and `rating_count` are denormalized for read performance, kept in sync by trigger.")

    doc.add_heading("Table 4: pharmacy_on_duty_rotas", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** The \"pharmacie de garde\" (on-duty pharmacy) schedule. Algerian law requires rotating pharmacies to stay open during nights, weekends, and holidays.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["pharmacy_id", "UUID (FK → pharmacies)", "Which pharmacy is on duty"],
            ["duty_date", "date", "The specific date of the duty shift"],
            ["duty_type", "text", "Type of shift: night, weekend, holiday"],
        ]
    )

    doc.add_heading("Table 5: medicines", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** The master catalogue of all 5,425 officially registered medicines in Algeria.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like a library catalogue — every book (medicine) that exists is listed here, whether or not any library branch (pharmacy) currently has it in stock.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "Unique medicine identifier"],
            ["commercial_name", "text", "Brand name (e.g., \"DOLIPRANE\")"],
            ["dci", "text", "Generic name / active ingredient (e.g., \"PARACETAMOL\")"],
            ["dosage_form", "text", "How the medicine is taken (COMPRIME, SIROP, etc.)"],
            ["strength", "text", "Dose per unit (e.g., \"500 MG\")"],
            ["laboratory", "text", "The manufacturer"],
            ["ean13", "char(13)", "EAN-13 barcode (GS1 prefix 613 for Algeria)"],
            ["nomenclature_year", "smallint", "Which edition of the nomenclature (e.g., 2026)"],
        ]
    )

    doc.add_heading("Table 6: medicine_equivalents", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Links between medicines that can substitute for each other. If DOLIPRANE is out of stock, the system can suggest DAFALGAN because they share the same DCI (PARACETAMOL).")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["medicine_id", "UUID (FK → medicines)", "The first medicine"],
            ["equivalent_id", "UUID (FK → medicines)", "The equivalent medicine"],
            ["equivalence_type", "text", "exact_generic or therapeutic_alternative"],
        ]
    )
    add_paragraph_with_formatting(doc, "**exact_generic:** Same molecule, same dose, same form (interchangeable). **therapeutic_alternative:** Different molecule, same therapeutic effect.")

    doc.add_heading("Table 7: pharmacy_stock", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** What each pharmacy actually has on its shelves, tracked per batch.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like a warehouse inventory system. Each row is a specific batch of a specific medicine at a specific pharmacy.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "Unique stock entry identifier"],
            ["pharmacy_id", "UUID (FK → pharmacies)", "Which pharmacy has this stock"],
            ["medicine_id", "UUID (FK → medicines)", "Which medicine"],
            ["batch_number", "text", "Manufacturer's batch/lot number"],
            ["barcode", "text", "The barcode on the physical box"],
            ["production_date", "date", "When this batch was manufactured"],
            ["expiry_date", "date", "When this batch expires"],
            ["total_quantity", "integer", "How many boxes are on the shelf"],
            ["reserved_quantity", "integer", "How many boxes are held for reservations"],
            ["unit_price_dzd", "numeric(10,2)", "Price per box in Algerian Dinars"],
        ]
    )
    add_paragraph_with_formatting(doc, "**Critical constraint:** `CHECK (total_quantity >= reserved_quantity)` — you can never reserve more boxes than exist. Available quantity = `total_quantity - reserved_quantity`.")

    doc.add_page_break()

    # ── Domain C ──
    doc.add_heading("Domain C: Reservations, Payments & Ratings (3 tables)", level=2)

    doc.add_heading("Table 8: reservations", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** When a patient reserves medicine for pickup at a pharmacy.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like a restaurant reservation — you book a table (medicine) for a specific time. If you don't show up, the reservation expires.")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "Unique reservation identifier"],
            ["patient_id", "UUID (FK → users)", "Who made the reservation"],
            ["stock_id", "UUID (FK → pharmacy_stock)", "Which specific stock batch is reserved"],
            ["quantity", "integer", "How many boxes (≥ 1)"],
            ["status", "reservation_status ENUM", "Current state in the lifecycle"],
            ["pickup_code", "char(6)", "6-digit verification code for pharmacy counter"],
            ["hold_expires_at", "timestamptz", "When the hold expires if not picked up"],
            ["total_price_dzd", "numeric(10,2)", "Total price (quantity × unit price)"],
        ]
    )

    add_paragraph_with_formatting(doc, "**The Reservation State Machine (enforced by trigger):**")
    add_code_block(doc,
        "pending_payment → confirmed_held → ready_for_pickup → completed\n"
        "pending_payment → cancelled\n"
        "confirmed_held  → expired\n"
        "confirmed_held  → cancelled\n"
        "\n"
        "Any other transition is REJECTED by the trigger."
    )

    doc.add_heading("Table 9: payments", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Every financial transaction processed through Chargily (Algeria's main payment gateway).")
    add_styled_table(doc,
        ["Column", "Type", "What It Stores"],
        [
            ["id", "UUID", "Unique payment identifier"],
            ["user_id", "UUID (FK → users)", "Who made the payment"],
            ["reservation_id", "UUID (FK → reservations)", "Which reservation (null for pro plan)"],
            ["purpose", "payment_purpose ENUM", "reservation_deposit or pro_plan"],
            ["amount_dzd", "numeric(10,2)", "Amount in Algerian Dinars"],
            ["status", "payment_status ENUM", "pending, succeeded, failed, refunded"],
            ["chargily_checkout_id", "text", "Unique Chargily ID (ensures webhook idempotency)"],
        ]
    )
    add_paragraph_with_formatting(doc, "**Webhook Idempotency:** The `chargily_checkout_id` UNIQUE constraint prevents processing the same payment notification twice.")

    doc.add_heading("Table 10: pharmacy_ratings", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Patient reviews of pharmacies after completing a reservation. Rating 1–5 with optional comment.")
    add_paragraph_with_formatting(doc, "**Key constraints:** One rating per reservation (UNIQUE). Reservation must be `completed` (trigger). Rating auto-recalculates pharmacy's `rating_avg` (trigger).")

    # ── Domain D ──
    doc.add_heading("Domain D: Prescriptions, Alerts & Demand Analytics (4 tables)", level=2)

    doc.add_heading("Table 11: prescriptions", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** When a patient uploads a prescription photo and broadcasts it to pharmacies in their wilaya.")
    add_paragraph_with_formatting(doc, "**Analogy:** Like posting a \"wanted\" ad — \"I need these medicines, which pharmacy has them?\"")

    doc.add_heading("Table 12: prescription_responses", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** A pharmacist's reply to a prescription request, with availability status (full, partial, unavailable) and optional referral to another pharmacy.")

    doc.add_heading("Table 13: stock_alerts_reminders", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Patient notifications. Two types:")
    add_bullet(doc, "**back_in_stock** — \"Notify me when this medicine is available nearby.\"")
    add_bullet(doc, "**refill_reminder** — \"Remind me in 30 days to buy more of my medication.\"")

    doc.add_heading("Table 14: search_logs", level=3)
    add_paragraph_with_formatting(doc, "**What it represents:** Anonymous log of every medicine search. Feeds into the `v_unmet_demand` view — what medicines people are searching for but can't find, grouped by wilaya. This is gold for pharmacies deciding what to stock.")

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 4: MEDICINE CATALOGUE
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("4. How the Medicine Catalogue Was Built", level=1)

    doc.add_heading("Source: Official Algerian Nomenclature", level=2)
    add_paragraph_with_formatting(doc, "The medicines table was populated from the **\"NOMENCLATURE NATIONALE DES PRODUITS PHARMACEUTIQUES\"** (National Nomenclature of Pharmaceutical Products), published by the Algerian **Ministry of Pharmaceutical Industry** (Ministère de l'Industrie Pharmaceutique), **August 2026 edition**.")
    add_paragraph_with_formatting(doc, "It contains **5,425 registered pharmaceutical products**, each with an official \"Décision d'Enregistrement\" (Registration Decision) number.")

    doc.add_heading("What the Nomenclature Contains", level=2)
    add_styled_table(doc,
        ["Field", "Example", "Our Column"],
        [
            ["Nom Commercial", "DOLIPRANE", "commercial_name"],
            ["DCI", "PARACETAMOL", "dci"],
            ["Forme", "COMPRIME", "dosage_form"],
            ["Dosage", "500 MG", "strength"],
            ["Laboratoire", "SANOFI AVENTIS", "laboratory"],
        ]
    )

    doc.add_heading("What is DCI?", level=2)
    add_paragraph_with_formatting(doc, "**DCI** stands for **\"Dénomination Commune Internationale\"** — in English, **International Nonproprietary Name (INN)**. It is the universal scientific name for a drug's active ingredient, assigned by the World Health Organization (WHO).")
    add_paragraph_with_formatting(doc, "The same molecule can have many brand names. PARACETAMOL is sold as Doliprane, Dafalgan, Efferalgan, Tylenol, and dozens more. DCI is the common thread that links all brands of the same molecule together.")

    doc.add_heading("Generated EAN-13 Barcodes", level=2)
    add_paragraph_with_formatting(doc, "The official nomenclature does not include barcodes. We generated EAN-13 barcodes using Algeria's GS1 country prefix (613), a sequential product code, and the standard check digit algorithm.")

    doc.add_heading("Auto-Generated Medicine Equivalents", level=2)
    add_paragraph_with_formatting(doc, "We automatically created `exact_generic` equivalence links by grouping medicines sharing the same DCI + strength + dosage form. For example, all medicines with `dci = 'PARACETAMOL'`, `strength = '500 MG'`, `dosage_form = 'COMPRIME'` are linked as exact generics.")

    doc.add_heading("Generated Pharmacy Data", level=2)
    add_paragraph_with_formatting(doc, "We generated **500 pharmacies** across all **58 Algerian wilayas** using the `algerian-geo` package, which provides real commune names and authentic GPS coordinates for each commune.")

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 5: SEARCH WALKTHROUGH
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("5. How a Medicine Search Works Step-by-Step", level=1)

    add_paragraph_with_formatting(doc, "**Scenario:** A patient in Bab Ezzouar, Algiers searches for \"Doliprane\"")
    add_paragraph_with_formatting(doc, "Let's trace every step from the moment the patient taps \"Search\" to the results appearing on screen.")

    doc.add_heading("Step 1: The Frontend Sends the Request", level=3)
    add_paragraph_with_formatting(doc, "The patient types \"Doliprane\" in the search bar. The app sends:")
    add_code_block(doc, '{\n  "query": "Doliprane",\n  "latitude": 36.7225,\n  "longitude": 3.1822,\n  "radius_meters": 5000\n}')
    add_paragraph_with_formatting(doc, "The coordinates (36.7225, 3.1822) are the patient's GPS location in Bab Ezzouar, a commune in eastern Algiers.")

    doc.add_heading("Step 2: Fuzzy Text Matching (pg_trgm)", level=3)
    add_paragraph_with_formatting(doc, "The database searches using trigram similarity:")
    add_code_block(doc, "SELECT id, commercial_name, dci\nFROM medicines\nWHERE commercial_name % 'Doliprane'\nORDER BY similarity(commercial_name, 'Doliprane') DESC;")
    add_paragraph_with_formatting(doc, "Even misspellings work: \"Dolipran\" ✓, \"doliprane\" ✓, \"Dolyprane\" ✓. The GIN index makes this fast.")

    doc.add_heading("Step 3: Find Equivalent Medicines", level=3)
    add_paragraph_with_formatting(doc, "We query `medicine_equivalents` to find all medicines with the same DCI (PARACETAMOL): DAFALGAN, EFFERALGAN, and other generics.")

    doc.add_heading("Step 4: Check Stock Availability", level=3)
    add_paragraph_with_formatting(doc, "We query `v_pharmacy_medicine_availability` for all pharmacies stocking Doliprane or any equivalent (non-expired batches only, available quantity > 0).")

    doc.add_heading("Step 5: Geographic Filtering (PostGIS)", level=3)
    add_paragraph_with_formatting(doc, "Filter only pharmacies within 5 km:")
    add_code_block(doc, "SELECT p.name, p.address,\n       ST_Distance(p.location, ST_MakePoint(3.1822, 36.7225)::geography) AS distance_meters\nFROM pharmacies p\nWHERE ST_DWithin(\n    p.location,\n    ST_MakePoint(3.1822, 36.7225)::geography,\n    5000  -- 5 km\n);")
    add_paragraph_with_formatting(doc, "**Note:** `ST_MakePoint(longitude, latitude)` — longitude comes first!")

    doc.add_heading("Step 6: Sort by Distance", level=3)
    add_paragraph_with_formatting(doc, "Results are ordered by distance (`ORDER BY distance_meters ASC`) so the closest pharmacy appears first.")

    doc.add_heading("Step 7: Build the Response", level=3)
    add_styled_table(doc,
        ["Field", "Example Value"],
        [
            ["Pharmacy name", "Pharmacie El Afia"],
            ["Distance", "1.2 km"],
            ["Medicine name", "DOLIPRANE 500MG COMPRIME"],
            ["Price", "150.00 DZD"],
            ["Available quantity", "23 boxes"],
            ["Stock status", "in_stock"],
            ["Rating", "⭐ 4.5 (42 reviews)"],
        ]
    )
    add_paragraph_with_formatting(doc, "If the original medicine isn't available but an equivalent is, the result shows: \"DOLIPRANE not found nearby. **DAFALGAN 500MG** (same DCI: PARACETAMOL) available at Pharmacie Central — 2.3 km away.\"")

    doc.add_heading("Step 8: Log the Search", level=3)
    add_paragraph_with_formatting(doc, "The search is recorded in `search_logs`. If no stock was found (`found_in_stock = false`), it feeds into `v_unmet_demand`, helping pharmacies identify what medicines people need but can't find.")

    doc.add_page_break()

    # ══════════════════════════════════════════════════════════════════════════
    # SECTION 6: DEFENSE QUESTIONS
    # ══════════════════════════════════════════════════════════════════════════
    doc.add_heading("6. How to Defend This in Front of the Professor", level=1)
    add_paragraph_with_formatting(doc, "Five questions a professor is likely to ask, with clear, confident answers.")

    # Q1
    doc.add_heading("Q1: \"Why didn't you just store stock_status as a column?\"", level=2)
    add_paragraph_with_formatting(doc, "**Answer:** Because `stock_status` is **derived data** — it's calculated from other values:")
    add_code_block(doc, "available = total_quantity - reserved_quantity\n\nif available = 0  → 'out_of_stock'\nif available ≤ 5  → 'low_stock'\nif available > 5  → 'in_stock'")
    add_paragraph_with_formatting(doc, "If we stored it as a column, we'd need to update it every time a reservation is created, cancelled, or expired — at least 3 different places in the code. If even one forgets, the status gets out of sync. Our view `v_pharmacy_stock_status` calculates it on the fly — it's **always correct**. This is the **DRY principle** applied to data.")

    # Q2
    doc.add_heading("Q2: \"What happens if two patients reserve the last box at the same time?\"", level=2)
    add_paragraph_with_formatting(doc, "**Answer:** Our `fn_create_reservation` uses `SELECT ... FOR UPDATE` which locks the stock row:")
    add_code_block(doc, "SELECT total_quantity, reserved_quantity\nFROM pharmacy_stock\nWHERE id = $1\nFOR UPDATE;  -- Locks this specific row")
    add_paragraph_with_formatting(doc, "Patient A's transaction locks the row, reserves the box, commits. Patient B's transaction then gets the lock, sees 0 available, and raises an error. **No double-booking is possible.** This is PostgreSQL's ACID-compliant row-level locking.")

    # Q3
    doc.add_heading("Q3: \"Why 14 tables? Isn't that too many?\"", level=2)
    add_paragraph_with_formatting(doc, "**Answer:** Each table represents **one distinct real-world concept** — the **Single Responsibility Principle** applied to database design (normalization).")
    add_paragraph_with_formatting(doc, "Merging tables would create \"wide tables\" with nullable columns and ambiguous data. For example, merging `prescriptions` into `reservations` means every reservation has empty prescription fields and vice versa.")
    add_paragraph_with_formatting(doc, "Our tables are **normalized to 3NF** (Third Normal Form): no data redundancy, no update anomalies. The only intentional denormalization is `rating_avg`/`rating_count` on pharmacies (kept in sync by trigger for read performance).")

    # Q4
    doc.add_heading("Q4: \"How do you handle expired reservations?\"", level=2)
    add_paragraph_with_formatting(doc, "**Answer:** `fn_expire_due_reservations()` runs periodically. It finds reservations where `hold_expires_at < now()` and status is still pending/confirmed. It uses `FOR UPDATE SKIP LOCKED` to avoid blocking active transactions, sets status to 'expired', and releases reserved quantity back to stock. Running it twice is safe — already-expired reservations can't transition again (state machine prevents it).")

    # Q5
    doc.add_heading("Q5: \"Why PostGIS instead of just storing lat/lng as numbers?\"", level=2)
    add_paragraph_with_formatting(doc, "**Answer:**")
    add_numbered(doc, "**No spatial indexes** — finding nearby pharmacies would require Haversine formula for every pharmacy (O(n) full scan)")
    add_numbered(doc, "**Haversine in app code is error-prone** — must handle edge cases, hope math is correct")
    add_numbered(doc, "**Geography type understands Earth's curvature** — plain numbers treat lat/lng as flat plane (inaccurate)")
    add_numbered(doc, "**Performance** — our target is sub-300ms search. PostGIS + GiST index gives O(log n) lookups instead of O(n)")
    add_paragraph_with_formatting(doc, "PostGIS gives us correctness, performance, and developer productivity — all without writing distance calculation code ourselves.")

    # ── Final note ──
    doc.add_paragraph("")
    final_p = doc.add_paragraph()
    final_p.paragraph_format.space_before = Pt(12)
    run = final_p.add_run("Final note: ")
    run.bold = True
    run.font.size = Pt(10)
    run = final_p.add_run("This database design was built with three principles: correctness (constraints, triggers, state machines prevent bad data), performance (GIN, GiST, and row-level locking for concurrent access), and Algerian context (Law 18-07 compliance, CHIFA integration, wilaya-based organization, pharmacie de garde schedules, and the official medicine nomenclature).")
    run.font.size = Pt(10)
    run.font.italic = True

    # ── Page numbers ──
    add_page_numbers(doc)

    # ── Save ──
    doc.save(str(OUTPUT_DOCX))
    print(f"✅ Document saved to: {OUTPUT_DOCX}")
    print(f"   File size: {OUTPUT_DOCX.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    build_document()
