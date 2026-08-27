const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = 3000;

// --- GLOBÁLNÍ ZÁMEK MATERIÁLŮ ---
let materialyUzamceny = false;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

console.log("=== Zkouším se připojit na hosta:", process.env.DB_HOST, "===");

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) throw err;
    console.log('Připojeno k databázi soatb.');
});

// --- POMOCNÁ FUNKCE PRO ZÁPIS LOGŮ ---
function zapisLog(idRekruta, akce) {
    db.query("INSERT INTO systemove_logy (id_rekruta, akce) VALUES (?, ?)", [idRekruta, akce], (err) => {
        if (err) console.error("Chyba při zápisu logu:", err);
    });
}

function generujHeslo(delka = 12) {
    const znaky = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let heslo = "";
    for (let i = 0; i < delka; i++) heslo += znaky.charAt(Math.floor(Math.random() * znaky.length));
    return heslo;
}

function vytvorLogin(celeJmeno) {
    const casti = celeJmeno.trim().toLowerCase().split(/\s+/);
    if (casti.length >= 2) return casti[casti.length - 1] + casti[0].charAt(0);
    return casti[0];
}

async function ulozObrazek(buffer) {
    const unikatniNazev = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.webp';
    const outputPath = path.join(uploadDir, unikatniNazev);
    await sharp(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(outputPath);
    return '/uploads/' + unikatniNazev;
}

function parseObrazky(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function removeFiles(urls) {
    urls.forEach(url => {
        if (!url) return;
        const filePath = path.join(__dirname, 'public', url);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch {}
        }
    });
}

// --- SYSTÉMOVÉ LOGY (API) ---
app.get('/api/admin/logy', (req, res) => {
    const sql = `
        SELECT l.id, l.akce, l.datum, r.jmeno 
        FROM systemove_logy l 
        LEFT JOIN rekruti r ON l.id_rekruta = r.id 
        ORDER BY l.datum DESC LIMIT 100
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ chyba: err.message });
        res.json(results);
    });
});

// --- ZÁMEK MATERIÁLŮ (API) ---
app.get('/api/admin/stav-materialu', (req, res) => {
    res.json({ uzamceno: materialyUzamceny });
});

app.post('/api/admin/toggle-materialy', (req, res) => {
    if (req.body.je_admin) {
        materialyUzamceny = req.body.uzamceno;
        zapisLog(req.body.id_admina, materialyUzamceny ? 'Uzamkl všechny studijní materiály.' : 'Odemkl studijní materiály pro rekruty.');
        res.json({ uspech: true, uzamceno: materialyUzamceny });
    } else {
        res.status(403).json({ chyba: 'Přístup odepřen.' });
    }
});

// --- REKRUTI ---
app.get('/api/rekruti', (req, res) => {
    db.query("SELECT * FROM rekruti", (err, results) => res.json(results));
});

app.post('/api/rekruti', (req, res) => {
    const { jmeno, hodnost, je_admin, id_admina } = req.body;
    const login = vytvorLogin(jmeno);
    const heslo = generujHeslo(12);

    db.query(
        "INSERT INTO rekruti (jmeno, hodnost, faze, login, heslo, je_admin) VALUES (?, ?, 'Phase I', ?, ?, ?)",
        [jmeno, hodnost || 'WOC', login, heslo, je_admin ? 1 : 0],
        (err, result) => {
            if (err) return res.status(500).json({ uspech: false, chyba: err.message });

            const noveId = result.insertId;
            zapisLog(id_admina, `Založil nový uživatelský profil pro: ${jmeno}`);
            
            db.query("SELECT id FROM testy", (err2, testy) => {
                if (err2 || testy.length === 0) return res.json({ uspech: true });
                const hodnotyProDb = testy.map(t => [noveId, t.id, 0]);
                db.query("INSERT INTO testy_pristupy (id_rekruta, id_testu, stav) VALUES ?", [hodnotyProDb], () => res.json({ uspech: true }));
            });
        }
    );
});

app.put('/api/rekruti/:id/hodnost', (req, res) => {
    db.query("UPDATE rekruti SET hodnost = ? WHERE id = ?", [req.body.hodnost, req.params.id], () => {
        zapisLog(req.body.id_admina, `Změnil hodnost člena (ID: ${req.params.id}) na: ${req.body.hodnost}`);
        res.json({ uspech: true });
    });
});

app.delete('/api/rekruti/:id', (req, res) => {
    zapisLog(null, `Smazán uživatelský profil (ID: ${req.params.id})`);
    db.query("DELETE FROM testy_pristupy WHERE id_rekruta = ?", [req.params.id], () => {
        db.query("DELETE FROM zaznamy_testu WHERE id_rekruta = ?", [req.params.id], () => {
            db.query("DELETE FROM rekruti WHERE id = ?", [req.params.id], () => res.json({ uspech: true }));
        });
    });
});

// --- AUTENTIZACE ---
app.post('/api/login', (req, res) => {
    db.query(
        "SELECT id, jmeno, hodnost, je_admin FROM rekruti WHERE login = ? AND heslo = ?",
        [req.body.login, req.body.heslo],
        (err, results) => {
            if (results.length > 0) {
                const r = results[0];
                r.je_admin = Number(r.je_admin);
                zapisLog(r.id, 'Uživatel se úspěšně přihlásil do portálu.');
                res.json({ uspech: true, rekrut: r });
            } else {
                res.status(401).json({ chyba: 'Neplatné jméno nebo heslo.' });
            }
        }
    );
});

// --- TESTY ---
app.get('/api/testy', (req, res) => {
    db.query("SELECT * FROM testy", (err, results) => res.json(results));
});

app.post('/api/testy', (req, res) => {
    db.query("INSERT INTO testy (nazev, popis) VALUES (?, ?)", [req.body.nazev, req.body.popis], (err, result) => {
        if (err) return res.status(500).json({ uspech: false });
        zapisLog(null, `Vytvořen nový výcvikový modul: ${req.body.nazev}`);
        res.json({ uspech: true, id: result.insertId });
    });
});

app.delete('/api/testy/:id', (req, res) => {
    db.query("DELETE FROM testy_pristupy WHERE id_testu = ?", [req.params.id], () => {
        db.query("DELETE FROM otazky WHERE id_testu = ?", [req.params.id], () => {
            db.query("DELETE FROM testy WHERE id = ?", [req.params.id], () => {
                zapisLog(null, `Smazán výcvikový modul (ID: ${req.params.id})`);
                res.json({ uspech: true });
            });
        });
    });
});

app.post('/api/otazky', (req, res) => {
    const { id_testu, zneni, a, b, c, spravna } = req.body;
    db.query(
        "INSERT INTO otazky (id_testu, zneni, odpoved_a, odpoved_b, odpoved_c, spravna_odpoved) VALUES (?, ?, ?, ?, ?, ?)",
        [id_testu, zneni, a, b, c, spravna],
        () => res.json({ uspech: true })
    );
});

app.get('/api/testy/:id/otazky', (req, res) => {
    db.query("SELECT id, zneni, odpoved_a, odpoved_b, odpoved_c FROM otazky WHERE id_testu = ?", [req.params.id], (err, results) => res.json(results));
});

app.get('/api/admin/testy/:id/otazky', (req, res) => {
    db.query("SELECT * FROM otazky WHERE id_testu = ?", [req.params.id], (err, results) => res.json(results));
});

app.delete('/api/otazky/:id', (req, res) => {
    db.query("DELETE FROM otazky WHERE id = ?", [req.params.id], () => res.json({ uspech: true }));
});

// --- MATERIÁLY A KAPITOLY (PDF PODPORA) ---
app.get('/api/materialy', (req, res) => {
    if (materialyUzamceny && req.query.admin !== '1' && req.query.admin !== 'true') {
        return res.status(403).json({ chyba: 'Materiály jsou uzamčeny.' });
    }
    db.query("SELECT * FROM materialy", (err, results) => res.json(results));
});

app.get('/api/materialy/:id', (req, res) => {
    db.query("SELECT * FROM materialy WHERE id = ?", [req.params.id], (err, results) => {
        if (!results || results.length === 0) return res.status(404).json({ chyba: 'Nenalezeno' });
        res.json(results[0]);
    });
});

app.post('/api/materialy', (req, res) => {
    const { nazev, popis } = req.body;
    db.query("INSERT INTO materialy (nazev, popis) VALUES (?, ?)", [nazev, popis], (err, result) => {
        if (err) return res.status(500).json({ uspech: false });
        zapisLog(null, `Vytvořen nový manuál: ${nazev}`);
        res.json({ uspech: true, id: result.insertId });
    });
});

app.delete('/api/materialy/:id', (req, res) => {
    db.query("SELECT obsah, obrazky FROM materialy_kapitoly WHERE id_materialu = ?", [req.params.id], (err, results) => {
        const urls = [];
        (results || []).forEach(r => {
            urls.push(...parseObrazky(r.obrazky));
            if (r.obsah && r.obsah.endsWith('.pdf')) urls.push(r.obsah);
        });
        removeFiles(urls);

        db.query("DELETE FROM materialy_kapitoly WHERE id_materialu = ?", [req.params.id], () => {
            db.query("DELETE FROM materialy WHERE id = ?", [req.params.id], () => {
                zapisLog(null, `Smazán manuál (ID: ${req.params.id})`);
                res.json({ uspech: true });
            });
        });
    });
});

app.get('/api/materialy/:id/kapitoly', (req, res) => {
    if (materialyUzamceny && req.query.admin !== '1' && req.query.admin !== 'true') {
        return res.status(403).json({ chyba: 'Materiály jsou uzamčeny.' });
    }
    const materialId = req.params.id;

    db.query(
        "SELECT id, id_materialu, nazev_kapitoly, obsah, obrazky FROM materialy_kapitoly WHERE id_materialu = ? ORDER BY id ASC",
        [materialId],
        (err, results) => {
            if (err) return res.status(500).json({ chyba: 'Chyba databáze při načítání kapitol.' });

            const mapped = (results || []).map(k => ({
                id: k.id,
                id_materialu: k.id_materialu,
                nazev_kapitoly: k.nazev_kapitoly,
                obsah: k.obsah,
                obrazky: parseObrazky(k.obrazky)
            }));
            res.json(mapped);
        }
    );
});

app.post('/api/kapitoly', upload.any(), async (req, res) => {
    try {
        const { id_materialu, nazev_kapitoly, typ_obsahu } = req.body;
        let obsahProDb = req.body.obsah || '';
        let obrazkyProDb = [];

        if (typ_obsahu === 'pdf') {
            const pdfFile = req.files && req.files.find(f => f.fieldname === 'pdfSoubor');
            if (pdfFile) {
                const unikatniNazev = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.pdf';
                const outputPath = path.join(uploadDir, unikatniNazev);
                fs.writeFileSync(outputPath, pdfFile.buffer);
                obsahProDb = '/uploads/' + unikatniNazev;
            }
        } else {
            const obrazkyFiles = req.files ? req.files.filter(f => f.fieldname === 'obrazky') : [];
            for (const file of obrazkyFiles) {
                obrazkyProDb.push(await ulozObrazek(file.buffer));
            }
        }

        db.query(
            "INSERT INTO materialy_kapitoly (id_materialu, nazev_kapitoly, obsah, obrazky) VALUES (?, ?, ?, ?)",
            [id_materialu, nazev_kapitoly, obsahProDb, JSON.stringify(obrazkyProDb)],
            (err, result) => {
                if (err) return res.status(500).json({ uspech: false, chyba: err.message });
                res.json({ uspech: true, id: result.insertId });
            }
        );
    } catch (error) {
        res.status(500).json({ uspech: false, chyba: error.message });
    }
});

app.put('/api/kapitoly/:id', upload.any(), async (req, res) => {
    try {
        const kapId = req.params.id;
        const { nazev_kapitoly, typ_obsahu, obsah_existujici } = req.body;

        db.query("SELECT obsah, obrazky FROM materialy_kapitoly WHERE id = ?", [kapId], async (err, results) => {
            if (err || results.length === 0) return res.status(404).json({ uspech: false });

            let obsahProDb = typ_obsahu === 'pdf' ? obsah_existujici : (req.body.obsah || '');
            let obrazkyProDb = typ_obsahu === 'text' ? parseObrazky(results[0].obrazky) : [];

            if (typ_obsahu === 'pdf') {
                const pdfFile = req.files && req.files.find(f => f.fieldname === 'pdfSoubor');
                if (pdfFile) {
                    const unikatniNazev = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.pdf';
                    const outputPath = path.join(uploadDir, unikatniNazev);
                    fs.writeFileSync(outputPath, pdfFile.buffer);
                    obsahProDb = '/uploads/' + unikatniNazev;
                    
                    // Smažeme staré PDF pokud jsme nahráli nové
                    if (obsah_existujici && obsah_existujici.endsWith('.pdf')) removeFiles([obsah_existujici]);
                }
            } else {
                const obrazkyFiles = req.files ? req.files.filter(f => f.fieldname === 'obrazky') : [];
                for (const file of obrazkyFiles) {
                    obrazkyProDb.push(await ulozObrazek(file.buffer));
                }
                if (results[0].obsah && results[0].obsah.endsWith('.pdf')) removeFiles([results[0].obsah]);
            }

            db.query(
                "UPDATE materialy_kapitoly SET nazev_kapitoly = ?, obsah = ?, obrazky = ? WHERE id = ?",
                [nazev_kapitoly, obsahProDb, JSON.stringify(obrazkyProDb), kapId],
                (err2) => {
                    if (err2) return res.status(500).json({ uspech: false, chyba: err2.message });
                    res.json({ uspech: true });
                }
            );
        });
    } catch (error) {
        res.status(500).json({ uspech: false, chyba: error.message });
    }
});

app.delete('/api/kapitoly/:id', (req, res) => {
    db.query("SELECT obsah, obrazky FROM materialy_kapitoly WHERE id = ?", [req.params.id], (err, results) => {
        if (results && results.length > 0) {
            const urls = parseObrazky(results[0].obrazky);
            if (results[0].obsah && results[0].obsah.endsWith('.pdf')) urls.push(results[0].obsah);
            removeFiles(urls);
        }
        db.query("DELETE FROM materialy_kapitoly WHERE id = ?", [req.params.id], () => res.json({ uspech: true }));
    });
});

// --- HISTORIE A HODNOCENÍ ---
app.get('/api/stav/:id_rekruta/:id_testu', (req, res) => {
    db.query("SELECT stav FROM testy_pristupy WHERE id_rekruta = ? AND id_testu = ?", [req.params.id_rekruta, req.params.id_testu], (err, result) => {
        res.json({ stav: result.length > 0 ? result[0].stav : 0 });
    });
});

app.post('/api/odemknout', (req, res) => {
    const { id_rekruta, id_testu } = req.body;
    db.query("SELECT * FROM testy_pristupy WHERE id_rekruta = ? AND id_testu = ?", [id_rekruta, id_testu], (err, result) => {
        if (result.length > 0) {
            db.query("UPDATE testy_pristupy SET stav = 1 WHERE id_rekruta = ? AND id_testu = ?", [id_rekruta, id_testu], () => {
                zapisLog(req.body.id_admina, `Odemčel plnění modulu #${id_testu} rekrutovi ID: ${id_rekruta}`);
                res.json({ uspech: true });
            });
        } else {
            db.query("INSERT INTO testy_pristupy (id_rekruta, id_testu, stav) VALUES (?, ?, 1)", [id_rekruta, id_testu], () => {
                zapisLog(req.body.id_admina, `Odemčel plnění modulu #${id_testu} rekrutovi ID: ${id_rekruta}`);
                res.json({ uspech: true });
            });
        }
    });
});

app.get('/api/rekruti/:id/zaznamy', (req, res) => {
    const sql = "SELECT z.id, z.id_testu, z.procenta, z.prosel, z.datum, z.odpovedi, t.nazev FROM zaznamy_testu z JOIN testy t ON z.id_testu = t.id WHERE z.id_rekruta = ? ORDER BY z.datum DESC";
    db.query(sql, [req.params.id], (err, results) => res.json(results));
});

app.post('/api/vyhodnotit', (req, res) => {
    const { id_rekruta, id_testu, odpovedi } = req.body;
    db.query("SELECT id, spravna_odpoved FROM otazky WHERE id_testu = ?", [id_testu], (err, spravneData) => {
        let skore = 0;
        const maxBodu = spravneData.length;

        spravneData.forEach(otazkaDb => {
            if (odpovedi[otazkaDb.id] === otazkaDb.spravna_odpoved) skore++;
        });

        const procenta = maxBodu > 0 ? (skore / maxBodu) * 100 : 0;
        const prosel = procenta >= 75;
        const novyStav = prosel ? 2 : 0;

        db.query(
            "INSERT INTO zaznamy_testu (id_rekruta, id_testu, procenta, prosel, odpovedi) VALUES (?, ?, ?, ?, ?)",
            [id_rekruta, id_testu, Math.round(procenta), prosel, JSON.stringify(odpovedi)],
            () => {
                db.query("UPDATE testy_pristupy SET stav = ? WHERE id_rekruta = ? AND id_testu = ?", [novyStav, id_rekruta, id_testu], () => {
                    zapisLog(id_rekruta, `Odevzdal zkoušku (Modul ${id_testu}) s úspěšností ${Math.round(procenta)}%.`);
                    res.json({ uspech: true, prosel, procenta: Math.round(procenta) });
                });
            }
        );
    });
});

app.listen(port, () => console.log(`Server SOATB běží na http://localhost:${port}`));