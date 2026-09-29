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

Kaggle → **Datasets → New Dataset**. Upload the three files, name it `bonded-sentinel`, and keep it **private**. Its files then appear at `/kaggle/input/bonded-sentinel/`. If Kaggle gives it a different slug, use that path below.

## 3. Open Laya's notebook in Kaggle

1. Kaggle → **Code → New Notebook → File → Import Notebook**, and paste the pinned GitHub URL above.
2. **Settings:** Accelerator **GPU T4 ×2**, Internet **on** (it installs packages and downloads the base model).
3. **Add Input:** your `bonded-sentinel` dataset.
4. **Add-ons → Secrets:** add `HF_TOKEN`, a Hugging Face token with write access.

## 4. Make six edits

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

## 5. Run all cells

When it finishes, check that the model card on your Hugging Face repo describes Sentinel (edit e) and that the report's `n_decisions` is three times `n_cases` (edit f). Then download `benchmark_report.json` (cell 18 writes it to the output folder) and add it to the repository under `docs/progress/evidence/`. Note the Hugging Face repo name and commit.

## What the result does and doesn't show

- The notebook's report on our `test.jsonl` is the first held-out number: real episodes from attack classes Sentinel never trained on. It is small (22 held-out rows from one scripted agent today, plus controls), so treat it as a smoke test.
- The proper evaluation is Day 10: more real held-out episodes, TPR at 1% FPR, calibration and latency (Section 10.3, step 4).
- Not verified here: this guide was written from the notebook's source and the reference dataset's schema, and a test mirrors the notebook's target computation. The notebook itself hasn't been run on our data. If a cell fails, send its error.
