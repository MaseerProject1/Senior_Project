from __future__ import annotations

from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from src.models.baselines import SeasonalNaiveRegressor

try:
    from xgboost import XGBRegressor
except ImportError:  # pragma: no cover
    XGBRegressor = None


def make_one_hot_encoder() -> OneHotEncoder:
    try:
        return OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    except TypeError:  # pragma: no cover
        return OneHotEncoder(handle_unknown="ignore", sparse=False)


def build_preprocessor(numeric_cols: list[str], categorical_cols: list[str]) -> ColumnTransformer:
    numeric_transformer = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
        ]
    )
    categorical_transformer = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="most_frequent")),
            ("onehot", make_one_hot_encoder()),
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("num", numeric_transformer, numeric_cols),
            ("cat", categorical_transformer, categorical_cols),
        ],
        remainder="drop",
    )


def build_tabular_model_registry(random_state: int) -> dict[str, object]:
    models: dict[str, object] = {
        "Seasonal Naive": SeasonalNaiveRegressor(),
        "Ridge Regression": Ridge(alpha=1.5),
        "Random Forest": RandomForestRegressor(
            n_estimators=60,
            max_depth=14,
            min_samples_leaf=2,
            n_jobs=1,
            random_state=random_state,
        ),
        "Gradient Boosting": GradientBoostingRegressor(
            n_estimators=100,
            learning_rate=0.05,
            max_depth=3,
            random_state=random_state,
        ),
    }
    if XGBRegressor is not None:
        models["XGBoost"] = XGBRegressor(
            objective="reg:squarederror",
            n_estimators=120,
            learning_rate=0.05,
            max_depth=5,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=1.0,
            random_state=random_state,
            n_jobs=4,
            tree_method="hist",
            verbosity=0,
        )
    return models
