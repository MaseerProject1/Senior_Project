from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from src.evaluation.metrics import regression_metrics


SEQUENCE_FEATURES = ["pickup_count", "hour", "day_of_week", "is_weekend", "is_holiday"]


class SequenceDataset(Dataset):
    def __init__(self, sequences: np.ndarray, targets: np.ndarray):
        self.sequences = torch.tensor(sequences, dtype=torch.float32)
        self.targets = torch.tensor(targets, dtype=torch.float32)

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, index: int):
        return self.sequences[index], self.targets[index]


class GRURegressor(nn.Module):
    def __init__(self, input_size: int, hidden_size: int, num_layers: int, dropout: float):
        super().__init__()
        recurrent_dropout = dropout if num_layers > 1 else 0.0
        self.gru = nn.GRU(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=recurrent_dropout,
        )
        self.head = nn.Sequential(nn.Linear(hidden_size, hidden_size), nn.ReLU(), nn.Linear(hidden_size, 1))

    def forward(self, sequence_batch: torch.Tensor) -> torch.Tensor:
        output, _ = self.gru(sequence_batch)
        last_hidden = output[:, -1, :]
        return self.head(last_hidden).squeeze(-1)


@dataclass
class SequenceArtifacts:
    state_dict: dict
    metrics: dict[str, float]
    history_window: int
    input_size: int
    feature_names: list[str]
    split_timestamp_min: str
    split_timestamp_max: str


def build_sequences(frame: pd.DataFrame, history_window: int) -> tuple[np.ndarray, np.ndarray, list[pd.Timestamp]]:
    sequences: list[np.ndarray] = []
    targets: list[float] = []
    timestamps: list[pd.Timestamp] = []
    for _, zone_df in frame.sort_values(["zone_id", "timestamp"]).groupby("zone_id"):
        values = zone_df[SEQUENCE_FEATURES].to_numpy(dtype=float)
        target_values = zone_df["target_pickup_count_next_hour"].to_numpy(dtype=float)
        ts_values = pd.to_datetime(zone_df["timestamp"]).tolist()
        if len(zone_df) <= history_window:
            continue
        for start_idx in range(0, len(zone_df) - history_window):
            end_idx = start_idx + history_window
            sequences.append(values[start_idx:end_idx])
            targets.append(target_values[end_idx - 1])
            timestamps.append(ts_values[end_idx - 1])
    return np.asarray(sequences), np.asarray(targets), timestamps


def train_gru_model(train_df: pd.DataFrame, validation_df: pd.DataFrame, test_df: pd.DataFrame, random_state: int, cfg: dict) -> tuple[SequenceArtifacts, np.ndarray]:
    torch.manual_seed(random_state)
    np.random.seed(random_state)
    history_window = 24
    train_x, train_y, _ = build_sequences(train_df, history_window)
    validation_x, validation_y, _ = build_sequences(validation_df, history_window)
    test_x, test_y, test_ts = build_sequences(test_df, history_window)
    if len(train_y) == 0 or len(validation_y) == 0 or len(test_y) == 0:
        raise ValueError("Not enough data to train the GRU sequence model.")

    train_loader = DataLoader(SequenceDataset(train_x, train_y), batch_size=int(cfg["batch_size"]), shuffle=True)
    validation_loader = DataLoader(SequenceDataset(validation_x, validation_y), batch_size=int(cfg["batch_size"]), shuffle=False)
    test_loader = DataLoader(SequenceDataset(test_x, test_y), batch_size=int(cfg["batch_size"]), shuffle=False)
    model = GRURegressor(
        input_size=train_x.shape[-1],
        hidden_size=int(cfg["hidden_size"]),
        num_layers=int(cfg["num_layers"]),
        dropout=float(cfg["dropout"]),
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=float(cfg["learning_rate"]))
    loss_fn = nn.MSELoss()

    best_val = float("inf")
    best_state: dict | None = None
    patience = int(cfg["patience"])
    wait = 0

    for _ in range(int(cfg["epochs"])):
        model.train()
        for batch_x, batch_y in train_loader:
            optimizer.zero_grad()
            pred = model(batch_x)
            loss = loss_fn(pred, batch_y)
            loss.backward()
            optimizer.step()
        model.eval()
        validation_losses = []
        with torch.no_grad():
            for batch_x, batch_y in validation_loader:
                pred = model(batch_x)
                validation_losses.append(float(loss_fn(pred, batch_y).item()))
        current_val = float(np.mean(validation_losses))
        if current_val < best_val:
            best_val = current_val
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            wait = 0
        else:
            wait += 1
            if wait >= patience:
                break

    if best_state is None:
        raise RuntimeError("GRU training did not produce a valid checkpoint.")

    model.load_state_dict(best_state)
    model.eval()
    predictions: list[np.ndarray] = []
    with torch.no_grad():
        for batch_x, _ in test_loader:
            predictions.append(model(batch_x).cpu().numpy())
    y_pred = np.concatenate(predictions)
    metrics = regression_metrics(test_y, y_pred)
    artifacts = SequenceArtifacts(
        state_dict=best_state,
        metrics=metrics,
        history_window=history_window,
        input_size=train_x.shape[-1],
        feature_names=SEQUENCE_FEATURES,
        split_timestamp_min=str(min(test_ts)),
        split_timestamp_max=str(max(test_ts)),
    )
    return artifacts, y_pred
