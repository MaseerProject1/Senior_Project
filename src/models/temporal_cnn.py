from __future__ import annotations

import torch
from torch import nn


class TemporalCNNForecaster(nn.Module):
    def __init__(self, input_size: int, channels: int, kernel_size: int, horizon: int, dropout: float):
        super().__init__()
        padding = kernel_size - 1
        self.network = nn.Sequential(
            nn.Conv1d(input_size, channels, kernel_size=kernel_size, padding=padding),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Conv1d(channels, channels, kernel_size=kernel_size, padding=padding),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.AdaptiveAvgPool1d(1),
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Linear(channels, channels), nn.ReLU(), nn.Linear(channels, horizon))

    def forward(self, sequence_batch: torch.Tensor) -> torch.Tensor:
        conv_input = sequence_batch.transpose(1, 2)
        encoded = self.network(conv_input)
        return self.head(encoded)
