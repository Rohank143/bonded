"""Find Laya rows whose state doesn't fit the fine-tune's input window.

Laya reads at most 1,024 tokens: the question and its options, then the state. A state that
doesn't fit is cut off, and what's cut may be the planted instruction, which would make the
row's label wrong. This measures every row with Laya's own tokenizer and writes the ids of the
rows that don't fit, one per line, for `sentinel:dataset --exclude-ids`.

    python check_tokens.py <dataset dir> <out file>

Needs `transformers` and the cached base model (services/sentinel's environment has both).
"""

import glob
import json
import sys
from pathlib import Path

from transformers import AutoTokenizer

WINDOW = 1024
# Separator and special tokens around the question head and the state.
MARGIN = 8


def main() -> None:
    dataset, out = Path(sys.argv[1]), Path(sys.argv[2])
    paths = glob.glob(
        str(Path.home() / ".cache/huggingface/hub/models--convaiinnovations--laya/snapshots/*/typed-decisions/tokenizer")
    )
    if not paths:
        sys.exit("Laya's tokenizer isn't cached; run the Sentinel service once first.")
    tok = AutoTokenizer.from_pretrained(paths[0])
    over, total = [], 0
    for name in ("train.jsonl", "test.jsonl"):
        for line in (dataset / name).read_text().splitlines():
            row = json.loads(line)
            total += 1
            questions = json.loads(row["questions"])
            head = max(len(tok(json.dumps({k: v}))["input_ids"]) for k, v in questions.items())
            if len(tok(row["state"])["input_ids"]) > WINDOW - head - MARGIN:
                over.append(row["id"])
    out.write_text("".join(f"{i}\n" for i in over))
    print(f"{len(over)} of {total} rows don't fit; ids written to {out}")


if __name__ == "__main__":
    main()
