# Fine-tuning Laya for Sentinel on Kaggle

Day 9 (docs/PLAN.md Section 10.3, step 3). The founder runs this; it needs a Kaggle account and a Hugging Face account. It takes about 4 to 5 hours on Kaggle's free 2×T4 GPUs.

We use Laya's own notebook, [`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`](https://github.com/NandhaKishorM/laya/blob/9d955671415fc19f069b9cc998928075c1f255ec/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb) (Apache-2.0), pinned to commit `9d95567` so the cell numbers below stay right. Our data has the same format as its reference dataset (`LocalLLaMA/typed-decisions`), so its training and calibration code runs unchanged. Its reporting and upload cells describe the original benchmark, so section 4 replaces them.

## 1. Build the dataset

From the repository root, once the synthetic set is complete:

```bash
pnpm sentinel:dataset --arena ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --synthetic datasets/sentinel-synthetic-train.jsonl
```

Paths are relative to `apps/arena`. This writes `apps/arena/datasets/laya/` with `train.jsonl`, `test.jsonl` and `manifest.json`:

- **train:** the synthetic rows plus real Arena rows from the trained classes.
- **test:** real Arena rows only, from the held-out classes A7 and A10 (`SENTINEL_HELD_OUT_CLASSES`), plus control episodes. Each test row's `workflow` names its group (`sentinel/A7`, `sentinel/A10`, `sentinel/control`), so the report gives results per group.
- **Leak checks:** the builder refuses synthetic rows from a held-out class. It leaves out of training any synthetic row seeded from a test episode, because the seed's content is in its prompt; the count is in the manifest. It also refuses rows whose seed isn't among the `--arena` files, since their provenance can't be checked.
- **manifest.json:** counts per class and label, the held-out classes, and the label confidences (real rows 0.95 on the labelled answer, synthetic 0.90; an assumption, since Laya trains on probabilities).

The data stays out of git.

## 2. Upload it to Kaggle

Kaggle → **Create → New Dataset**. Upload the three files, name it `bonded-sentinel`, and keep it **private**.

**Find its exact path.** Once it's attached to the notebook (step 3), click the copy icon next to it in the notebook's **Input** panel. Newer accounts mount datasets at `/kaggle/input/datasets/<your-kaggle-username>/bonded-sentinel/`; older ones at `/kaggle/input/bonded-sentinel/`. The code below uses the short form: wherever it says `/kaggle/input/bonded-sentinel/`, use the path you copied.

## 3. Open Laya's notebook in Kaggle

Before you start:
- **Kaggle:** verify your phone number (Settings), or the GPU and Internet options stay unavailable.
- **Hugging Face:** create an account if needed. Your username is in your profile address (`huggingface.co/<username>`). Then **Settings → Access Tokens → Create new token**, type **Write**, and copy it at once, because it's shown only once.

Then:
1. Kaggle → **Code → New Notebook → File → Import Notebook**, and paste the pinned GitHub URL above.
2. **Settings** (right-hand panel, Session options): Accelerator **GPU T4 ×2**, Internet **on** (it installs packages and downloads the base model). Leave Environment on "Pin to original environment".
3. **Input** (top of the right-hand panel): **+ Add Input** → your `bonded-sentinel` dataset. Copy its path from the copy icon (step 2).
4. **Add-ons → Secrets → + Add Secret:** label `HF_TOKEN`, value the write token, and tick the notebook's checkbox. Only the upload cell reads it; a warning about "unauthenticated requests" while the public base model downloads is harmless.

## 4. Make six edits

**Shortcut:** [`bonded-sentinel.ipynb`](bonded-sentinel.ipynb) is Laya's notebook with all six edits already made (plus an upload of the report at the end of cell 18), for the founder's Kaggle dataset path and Hugging Face repo. Import it with **File → Import Notebook** and skip to section 5; change the path in cells 6, 12 and 16 and `NEW_REPO` in cell 16 if yours differ. The edits it contains:

Cell numbers count from 0, as in the notebook file.

**a. Pin the package** in the install cell (cell 4). Replace `"laya>=0.1.6"` with:

```python
"laya==0.3.21"
```

**b. Pin the base model** in the data cell (cell 6). Replace `model_dir = snapshot_download(MODEL_ID)` with:

```python
model_dir = snapshot_download(MODEL_ID, revision="55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851")
```

These were the latest release and model revision on September 29, 2026.

**c. Load our data.** Replace the two `load_dataset("LocalLLaMA/typed-decisions", "all", split=...)` calls, in cell 6 (train) and cell 12 (test):

```python
ds_train = load_dataset("json", data_files="/kaggle/input/bonded-sentinel/train.jsonl", split="train")
```

```python
ds_test = load_dataset("json", data_files="/kaggle/input/bonded-sentinel/test.jsonl", split="train")
```

(`split="train"` is correct in both: a single JSON file loads as one split.)

**d. Drop the upstream comparison** in the results cell (cell 14). Replace everything from `comparison_data = [` to the end of the cell with the block below. The Jev, ModernBERT and teacher rows were measured on the original benchmark, not on our data, so they can't sit next to our numbers.

```python
comparison_data = [{
    "Model": "Laya (fine-tuned for Bonded Sentinel)",
    "Accuracy": round(float(laya_acc), 3),
    "Soft Acc": round(float(laya_soft_acc), 3),
    "Brier": round(float(laya_brier), 3),
    "ECE": round(float(laya_ece), 3),
    "ms/case": round(float(laya_latency), 1),
}]
df_comp = pd.DataFrame(comparison_data)
print(df_comp.to_markdown(index=False))
```

**e. Replace the whole upload cell** (cell 16) with the block below. It uploads to **your private repo** with a model card describing our data. The original writes a public card claiming training on the original benchmark. Set your Hugging Face username first.

```python
import os, json
from huggingface_hub import HfApi
from kaggle_secrets import UserSecretsClient

token = UserSecretsClient().get_secret("HF_TOKEN")
NEW_REPO = "<your-hf-username>/bonded-sentinel-laya"
manifest = json.load(open("/kaggle/input/bonded-sentinel/manifest.json"))
n_test_decisions = sum(len(json.loads(r["questions"])) for r in ds_test)

readme = f"""---
license: apache-2.0
library_name: transformers
tags: [laya, bonded, sentinel]
---
# Bonded Sentinel (Laya fine-tune)

Private. Laya (`convaiinnovations/laya`, revision 55cf4c4) fine-tuned to answer Bonded Sentinel's
three questions about an AI trading agent's proposed action: manipulated, action_risk and
injection_in_inputs.

- Training: {len(ds_train)} cases (real Arena episodes and synthetic examples). Attack classes
  {', '.join(manifest['heldOutClasses'])} are held out; {manifest['droppedSeededFromTest']}
  synthetic rows seeded from test episodes were left out.
- Test: {len(ds_test)} real Arena cases ({n_test_decisions} decisions) from the held-out classes
  plus control episodes. Small: a smoke test, not the full evaluation.
- Test accuracy {laya_acc:.3f}, Brier {laya_brier:.3f}, ECE {laya_ece:.3f}, p50 latency
  {laya_latency:.1f} ms on a Kaggle T4.

Advisory only: Bonded pays claims from on-chain vault records, never from this model.
"""
with open(os.path.join(OUTPUT_DIR, "README.md"), "w") as f:
    f.write(readme)

api = HfApi(token=token)
api.create_repo(NEW_REPO, repo_type="model", private=True, exist_ok=True)
api.upload_folder(
    folder_path=OUTPUT_DIR,
    repo_id=NEW_REPO,
    repo_type="model",
    commit_message=f"Bonded Sentinel fine-tune: held-out test accuracy {laya_acc:.3f}",
)
print(f"Uploaded to https://huggingface.co/{NEW_REPO} (private)")
```

Never push to `convaiinnovations/...`.

**f. Fix the report** in the report cell (cell 18). Make three replacements:

- `"benchmark": "LocalLLaMA/typed-decisions",` becomes

  ```python
  "benchmark": "bonded-sentinel (held-out A7, A10 and controls)",
  ```

- `"n_decisions": len(ds_test) * 5,` becomes (Sentinel asks three questions per case, not five)

  ```python
  "n_decisions": sum(len(json.loads(r["questions"])) for r in ds_test),
  ```

- `for wf in ["agent_trace_observability", "customer_service", "invoice_processing", "security_incidents"]:` becomes

  ```python
  for wf in sorted({item["workflow"] for item in predictions}):
  ```

With these, the report has one entry per test group (`sentinel/A7`, `sentinel/A10`, `sentinel/control`) and the correct decision count.

## 5. Run it as a saved version

Run it with **Save Version → Save & Run All (Commit)**, not Run All in the editor:
- **Version name:** for example `sentinel-v1`.
- **Advanced Settings:** check it runs with the GPU.
- Then stop the idle editor session with the power icon, so it doesn't use GPU quota.

A committed version runs in the background for up to 12 hours, and you can close the browser. The editor's **Draft Session** is interactive: when the connection dropped during the first attempt, Kaggle ended it after about two and a half epochs and the training was lost.

Things seen on the first run:
- **Saving edits:** Kaggle saves edits automatically. Cmd+S opens the browser's own "Save page" dialog instead; cancel it. To make Kaggle save, type a space in a cell and delete it, then wait for "Draft saved".
- **"ConcurrencyViolation … Sequence number must match Draft record":** the editor is behind Kaggle's saved copy, for example after a dropped connection or with the notebook open in two tabs. Back up with **File → Download notebook**, close other tabs, reload, check the edits are still there (re-import the download if not), and save the version again.
- **Checking it loaded our data:** the training output reports about 27,000 train items (three per case, less 400 kept for calibration). The original dataset would show about 6,000.
- **Harmless messages:** cell 6 prints "Downloading LocalLLaMA/typed-decisions" before loading whatever the next line loads. The `OMP_NUM_THREADS`, `find_unused_parameters` and `lr_scheduler.step()` warnings come from the upstream code.
- **Time:** at about 27,000 items, training runs roughly 1,690 steps per epoch on each GPU, 4 epochs.

When it finishes, check that the model card on your Hugging Face repo describes Sentinel (edit e) and that the report's `n_decisions` is three times `n_cases` (edit f). Then download `benchmark_report.json` (cell 18 writes it to the output folder) and add it to the repository under `docs/progress/evidence/`. Note the Hugging Face repo name and commit.

## Retraining (v2 and later)

The notebook keeps its edits, so a retrain is: new data, a check of the edits, and a new saved version.

1. **Build the new dataset** (the command in section 1, with the new `--synthetic` file) and check its manifest. For v2, from `apps/arena`:

   ```bash
   cat datasets/sentinel-synthetic-train.jsonl datasets/sentinel-synthetic-sells.jsonl > datasets/sentinel-synthetic-train-v2.jsonl
   ```

   ```bash
   node dist/laya-dataset-cli.js --arena ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --synthetic datasets/sentinel-synthetic-train-v2.jsonl --out datasets/laya-v2
   ```
2. **Upload it as a new version** of the same Kaggle dataset: open `bonded-sentinel` → **New Version** → replace `train.jsonl`, `test.jsonl` and `manifest.json` → **Create**. The path stays the same.
3. **Import [`bonded-sentinel.ipynb`](bonded-sentinel.ipynb)** into the notebook (**File → Import Notebook**), so all six edits are in. v1's saved version was missing edits a, b, d and f: it installed the latest Laya (0.3.22) with an unpinned base model, and its report kept the upstream benchmark name, counted five decisions per case and showed the upstream comparison rows.
4. **Make sure the notebook uses the new data version:** in the **Input** panel, if `bonded-sentinel` offers an update, take it.
5. **Save Version → Save & Run All (Commit)**, named `sentinel-v2`.
6. The upload cell pushes to the same Hugging Face repo as a new commit. v1 stays as the earlier commit, so it's the rollback: the service serves whichever commit `SENTINEL_MODEL_REVISION` pins.

Then send the new commit hash. The new model goes live only if it scores at least as well as v1 on the held-out attacks and the benign trades (`docs/SENTINEL.md`, "When to retrain").

## What the result does and doesn't show

- The notebook's report on our `test.jsonl` is the first held-out number: real episodes from attack classes Sentinel never trained on. It is small (22 held-out rows from one scripted agent today, plus controls), so treat it as a smoke test.
- The proper evaluation is Day 10: more real held-out episodes, TPR at 1% FPR, calibration and latency (Section 10.3, step 4).
- How this guide was checked: it was written from the notebook's source and the reference dataset's schema, and a test mirrors the notebook's target computation. The first run on our data (September 29) loaded it and trained into the third epoch before that session was lost; the committed rerun's results go under `docs/progress/evidence/` when it finishes. If a cell fails, send its error.
