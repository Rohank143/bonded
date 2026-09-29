# Fine-tuning Laya for Sentinel on Kaggle

Day 9 (docs/PLAN.md Section 10.3, step 3). The founder runs this; it needs a Kaggle account and a Hugging Face account. It takes about 4 to 5 hours on Kaggle's free 2×T4 GPUs.

We use Laya's own notebook, [`laya_finetune_typed_decisions_2xT4_kaggle.ipynb`](https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb) (Apache-2.0), with four small edits: pinned versions, our data, a private upload and a new repo name. Our data uses the same format as its reference dataset (`LocalLLaMA/typed-decisions`), so its training, calibration and evaluation code runs unchanged.

## 1. Build the dataset

From the repository root, once the synthetic set is complete:

```bash
pnpm sentinel:dataset --arena ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --synthetic datasets/sentinel-synthetic-train.jsonl
```

Paths are relative to `apps/arena`. This writes `apps/arena/datasets/laya/` with `train.jsonl`, `test.jsonl` and `manifest.json`:

- **train:** the synthetic rows plus real Arena rows from the trained classes.
- **test:** real Arena rows only, from the held-out classes A7 and A10 (`SENTINEL_HELD_OUT_CLASSES`), plus control episodes. The builder refuses to put a held-out class into training.
- **manifest.json:** counts per class and label, the held-out classes, and the label confidences (real rows 0.95 on the labelled answer, synthetic 0.90; an assumption, since Laya trains on probabilities).

The data stays out of git.

## 2. Upload it to Kaggle

Kaggle → **Datasets → New Dataset**. Upload the three files, name it `bonded-sentinel`, and keep it **private**. Its files then appear at `/kaggle/input/bonded-sentinel/`. If Kaggle gives it a different slug, use that path below.

## 3. Open Laya's notebook in Kaggle

1. Kaggle → **Code → New Notebook → File → Import Notebook**, and paste the GitHub URL above.
2. **Settings:** Accelerator **GPU T4 ×2**, Internet **on** (it installs packages and downloads the base model).
3. **Add Input:** your `bonded-sentinel` dataset.
4. **Add-ons → Secrets:** add `HF_TOKEN`, a Hugging Face token with write access.

## 4. Make four edits

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

**d. Upload privately** in the optional push cell (cell 16). Change the repo name to your own account:

```python
NEW_REPO = "<your-hf-username>/bonded-sentinel-laya"
```

and make the repo private in the `create_repo` line:

```python
api.create_repo(NEW_REPO, repo_type="model", private=True, exist_ok=True)
```

The weights stay private (plan Section 10.3). Never push to `convaiinnovations/...`.

## 5. Run all cells

When it finishes, download `benchmark_report.json` (cell 18 writes it to the output folder) and add it to the repository under `docs/progress/evidence/`. Note the Hugging Face repo name and commit.

## What the result does and doesn't show

- The notebook's report on our `test.jsonl` is the first held-out number: real episodes from attack classes Sentinel never trained on. It is small (22 held-out rows from one scripted agent today, plus controls), so treat it as a smoke test.
- The proper evaluation is Day 10: more real held-out episodes, TPR at 1% FPR, calibration and latency (Section 10.3, step 4).
- Not verified here: this guide was written from the notebook's source and the reference dataset's schema, and a test mirrors the notebook's target computation. The notebook itself hasn't been run on our data. If a cell fails, send its error.
