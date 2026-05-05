from __future__ import annotations

import torch
from torch import nn


class LSTMForecaster(nn.Module):
    def __init__(self, input_size: int, hidden_size: int, num_layers: int, dropout: float, horizon: int):
        super().__init__()
        recurrent_dropout = dropout if num_layers > 1 else 0.0
        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=recurrent_dropout,
        )
        self.head = nn.Sequential(nn.Linear(hidden_size, hidden_size), nn.ReLU(), nn.Linear(hidden_size, horizon))

    def forward(self, sequence_batch: torch.Tensor) -> torch.Tensor:
        output, _ = self.lstm(sequence_batch)
        last_hidden = output[:, -1, :]
        return self.head(last_hidden)
