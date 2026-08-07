# Testing the Run panel before you publish

Everything below is done from your **Desktop** copy, not `F:\codeforge`.

```bat
cd /d C:\Users\ilia\Desktop\codeforge
npm install
npm run dev
```

> ⚠️ The panel appears **only after a real export** — not after a dry run, and
> not when the format is ZIP. If you cannot find it, that is almost always why.

---

## The 60-second version

If you only do one thing, do this:

1. Create a project, add one table, go to **Export**
2. Format **Folder** → **Generate**
3. Scroll down — a **Run it** panel appears under the format cards
4. Click **Start everything**
5. A terminal window opens and starts installing

That is the whole feature. Everything below is checking the edges.

---

## 1 · Automated checks first

These take seconds and catch most breakage before you touch the UI:

```bat
node scripts\test-launcher.cjs
```

Expect **22 passed, 0 failed**. This exercises the real module: version
parsing, project-state detection, every refusal path, and an actual terminal
launch against a fake terminal binary.

```bat
cd engine
.venv\Scripts\python -m pytest tests\ -q
cd ..
node scripts\test-github.cjs
```

Expect `286 passed` and `10 passed`.

---

## 2 · The happy path

**Setup**

1. **Create Project** → name it `Run Test` → click through the wizard
2. **Database** → add a table `users` with:
   - `id` — integer, primary key
   - `email` — string, unique
   - `full_name` — string
3. **API** → **Generate CRUD** for `users`
4. **Export** → format **Folder** → **Generate**

**What you should see**

Scroll down past the format cards. A panel titled **Run this project**:

```
ON THIS MACHINE                                    [Ready]
 ✓ Python      Python 3.13.x
 ✓ Node.js     v20.x.x
 ✓ npm         npm 10.x.x

🕐 First run                          about 4 minutes
   ✨ Python virtualenv     — will be created, then pip install
   ✨ Frontend dependencies — npm install — the slow one
   ✨ Sample data           — rows inserted on first start

 ▶ Start everything
   Sets up, then runs the API and the frontend
```

| Check | Should be |
|---|---|
| Versions | The **real** versions on your machine, not placeholders |
| Badge | Green **Ready** |
| Estimate | Roughly 3–5 minutes on a first run |
| Path at the bottom | Your actual project folder |

**Now click `Start everything`.**

- A terminal window opens — **Windows Terminal** if you have it, otherwise
  Command Prompt
- The panel shows a green *Opened in …* box
- The terminal starts creating the virtualenv and running pip

Let it finish. It is genuinely slow the first time; that is the point of the
estimate. When it is done, two more windows appear and you can open
`http://localhost:5173`.

---

## 3 · The state detection

This is the part most likely to be subtly wrong, so it is worth a minute.

**After** the first run has completed, come back to Skaffo and click the
🔄 refresh icon in the panel header.

The panel should now say:

```
🕐 Everything is set up                     a few seconds
   ✓ Python virtualenv          (struck through)
   ✓ Frontend dependencies      (struck through)
   ✓ Sample data                (struck through)
```

If it still says *First run*, the detection is broken — tell me.

---

## 4 · The other four modes

Click **More ways to run it**.

**Before** the first run, three of them should be dimmed with a small chip:

| Mode | Chip |
|---|---|
| API only | `needs first run` |
| Frontend only | `needs npm install` |
| Reset sample data | `needs first run` |

**After** the first run they should all be clickable. Try each one:

| Mode | Expected |
|---|---|
| **API only** | Terminal runs uvicorn; `127.0.0.1:8000/docs` works |
| **Frontend only** | Terminal runs Vite; `localhost:5173` works |
| **Reset sample data** | Prints `clear` then `seed` lines, row counts unchanged |
| **Just a shell** | A terminal sitting in the project folder, nothing running |

---

## 5 · The failure paths

Good errors are most of the value here, so these are worth testing.

### A missing prerequisite

The honest way to test this is on a machine without Python — but you can get
most of the way by checking the panel *predicts* correctly. If you have a
second PC without Python, install Skaffo there and open the panel: it should
show a red **Python** card, an explanation, a **Get Python** link, and the
**Start everything** button should be **disabled**.

### A deleted folder

1. Export a project
2. Delete the output folder in Explorer
3. Back in Skaffo, click **Start everything**

Expected:

> **That folder no longer exists.**
> Expected it at `C:\...`. Generate the project again.

### A project with no run script

1. Export, then delete `run.bat` from the project folder
2. Click **Start everything**

Expected:

> **run.bat is missing from the project.**
> Re-export with "Include run.bat / run.sh" switched on.

---

## 6 · Two Windows-specific things

**Windows Terminal vs Command Prompt.** The launcher tries `wt.exe` first
because that is what modern Windows installs use, and falls back to `cmd`.
Tell me which one opened for you — I only have Linux terminals to test
against here.

**A hostile project name.** Make a project called:

```
My Shop$(echo pwned)
```

Export it, then click **Start everything**. The terminal should open in a
folder named something like `my-shop-echo-pwned` and **nothing should
execute**. The path is passed to the terminal as its own argument rather than
spliced into a command string, and there is a test pinning that — but this is
the one place I would like a real Windows confirmation.

---

## What to report back

Even a one-line answer is useful:

- [ ] `node scripts\test-launcher.cjs` → 19 passed
- [ ] Panel appears after Generate, versions are real
- [ ] `Start everything` opens a terminal — **which one?**
- [ ] After the run finishes, refresh shows *Everything is set up*
- [ ] The four extra modes work
- [ ] Deleting the folder gives the friendly error, not a crash

If anything is off, paste what you saw and I will fix it before this goes out.
