# Supervisor Notes Report

This report explains the academic and theoretical document updates required for the capstone project **AI-Driven NYC Taxi Demand Pressure Forecasting**. It is intended to guide the next revision of the written report so that it is consistent with the practical system.

## 1. Abstract Page

The Abstract should be moved to a separate standalone page before the main chapters. It should briefly state the project problem, the NYC TLC Yellow Trip Data source, the use of weather and event/incident context, the forecasting target, the main models, and the Streamlit dashboard output.

## 2. Acknowledgment Page

An Acknowledgment page should be added near the beginning of the report in this order:

1. Saudi Arabia
2. The University
3. University President
4. College Dean / College President
5. Doctors / Faculty members
6. Supervisor
7. Family or team if suitable

Suggested academic draft:

> First and foremost, we express our sincere gratitude to the Kingdom of Saudi Arabia for its continuous support of education, research, and innovation. We extend our appreciation to the University for providing the academic environment and resources that enabled the completion of this project. We also thank the University President for supporting student development and applied research, and we are grateful to the College Dean and college leadership for their guidance and encouragement. Our sincere thanks go to the doctors and faculty members whose teaching and feedback strengthened our knowledge throughout the program. We are especially grateful to our supervisor for the valuable direction, constructive comments, and continuous support provided during this capstone project. Finally, we thank our families and team members for their patience, encouragement, and cooperation throughout this work.

## 3. Table of Contents Additions

The front matter should include:

- Table of Contents
- List of Tables
- List of Figures

These sections should appear before Chapter 1 and after the Abstract and Acknowledgment pages.

## 4. Data Understanding Chapter

The Data Understanding chapter should present tables before long explanatory paragraphs. For each dataset, include:

- Dataset summary table
- Columns/data dictionary table
- Missing values table
- Short explanation after the table
- Related figures

The report should cover the Yellow Taxi Dataset, Taxi Zone Lookup, Weather Dataset, and Event/Incident Dataset separately before explaining integration.

## 5. Data Cleaning Chapter

The Data Cleaning chapter must include figures and before/after evidence:

- Missing values before and after cleaning
- Outliers before and after cleaning
- Weather data before and after preprocessing
- Row count before and after cleaning
- Explanation of cleaning rules

Cleaning rules should explicitly mention invalid timestamps, invalid pickup/dropoff zones, trip duration limits, trip distance limits, fare/amount limits, and passenger count limits.

## 6. Wider Dataset Exploration

Each dataset should have wider exploration. The main report should include only the most important results, while detailed additional EDA outputs should be moved to the Appendix.

Recommended main-report outputs include dataset size, missing values, top taxi zones, hourly pickup patterns, weather distributions, and event/incident frequency. Appendix material can include full column listings, descriptive statistics, duplicate checks, and additional distribution plots.

## 7. Final Merged Dataset Section

The report should add a section titled **Final Merged Modeling Dataset**.

Recommended text:

> The final modeling dataset was constructed at the hourly taxi-zone level. Raw NYC TLC Yellow Trip Data was first cleaned and aggregated into hourly pickup-demand records by TLC taxi zone. The Taxi Zone Lookup table was then merged to add spatial descriptors such as borough, official zone name, and service zone. Hourly weather variables were joined by timestamp, while event and incident variables were joined by timestamp and zone identifier when zone-level information was available. Additional calendar, lag, rolling-window, and interaction features were engineered to capture temporal demand patterns and contextual effects. The target variable is `target_pickup_count_next_hour`, which represents the next-hour pickup count for each taxi zone and is used as a demand-pressure proxy.

The section should include a merged dataset table showing:

- Number of rows
- Number of columns
- Time range
- Number of zones
- Target column
- Main feature groups

An explanation should follow the table describing why the selected columns were used: taxi demand features capture observed mobility intensity, taxi-zone fields capture spatial context, weather variables capture environmental effects, event/incident variables capture disruptions, and lag/rolling/calendar features capture temporal demand patterns.

## 8. Future Work and Conclusion Separation

Conclusion and Future Work must be separated into two independent sections.

- **Conclusion:** Summarizes what the project achieved, including data integration, demand-pressure forecasting, model comparison, evaluation, and dashboard deployment.
- **Future Work:** Lists future improvements, such as real-time data integration, additional supply-side features, improved incident detection, longer historical training periods, and deployment enhancements.

## 9. Future Work Update

Add the following professionally written point to the Future Work section:

> Future work may integrate the forecasting system with Saher traffic cameras or similar real-time traffic camera infrastructure. Such integration would allow road accidents and traffic disruptions to be detected automatically from live visual or traffic-monitoring feeds. These real-time incident signals could then be incorporated into the trained forecasting pipeline so that taxi demand-pressure predictions are updated dynamically as urban conditions change.

## 10. References Expansion

The current references should be expanded. Do not invent fake references. Add verified sources under these categories:

- NYC TLC dataset documentation: `[Add official NYC TLC Trip Record Data documentation]`
- NYC TLC Yellow Taxi data dictionary: `[Add official Yellow Taxi data dictionary]`
- Taxi demand forecasting papers: `[Add peer-reviewed taxi demand forecasting studies]`
- Spatiotemporal forecasting papers: `[Add peer-reviewed spatial-temporal demand forecasting studies]`
- Weather impact on transportation demand: `[Add studies on weather and mobility demand]`
- Event/incident impact on urban mobility: `[Add studies on disruptions, incidents, and travel demand]`
- XGBoost reference: `[Add original XGBoost paper or documentation]`
- LSTM/GRU/TCN references: `[Add original or authoritative sequence-model references]`
- Streamlit or dashboard reference if needed: `[Add Streamlit documentation]`
- Open-Meteo reference: `[Add Open-Meteo documentation or citation guidance]`
- NYC Open Data collision dataset reference: `[Add NYC Open Data Motor Vehicle Collisions dataset documentation]`

## 11. Evaluation Metrics Explanation

### RMSE

Formula:

```text
RMSE = sqrt((1/n) * sum((y_i - yhat_i)^2))
```

RMSE measures the square root of the average squared prediction error. It is useful because it penalizes larger errors more strongly than smaller errors. In taxi demand forecasting, a lower RMSE means that the predicted next-hour pickup counts are closer to the observed pickup counts. A high RMSE indicates larger forecasting errors, especially during high-demand or unusual periods.

### MAE

Formula:

```text
MAE = (1/n) * sum(|y_i - yhat_i|)
```

MAE measures the average absolute difference between actual and predicted values. It is easy to interpret because it is expressed in the same unit as the target variable: pickup counts. In this project, a lower MAE means the model usually makes smaller next-hour demand errors per taxi zone.

### R²

Formula:

```text
R² = 1 - (sum((y_i - yhat_i)^2) / sum((y_i - ybar)^2))
```

R² measures how much variance in the target variable is explained by the model compared with a mean-only baseline. A higher R² indicates better explanatory power. In taxi demand forecasting, a strong R² means the model captures a meaningful share of zone-hour demand variation. A low or negative R² suggests the model performs poorly compared with a simple average-demand baseline.

## 12. Yellow Trip Data Review

The Yellow Trip Data section should be rewritten more clearly:

- State that the data comes from the NYC Taxi and Limousine Commission.
- Describe raw columns such as pickup/dropoff datetime, pickup/dropoff location IDs, passenger count, trip distance, fare amount, total amount, payment fields, and trip-level charges.
- Explain cleaning steps including timestamp validation, duplicate removal, outlier removal, and valid taxi-zone filtering.
- Explain that raw trip-level records are aggregated into hourly taxi-zone records.
- State that these hourly records are the foundation for model training and the target variable.

## 13. Taxi Zone Lookup Explanation

Suggested academic explanation:

> The Taxi Zone Lookup table is an official NYC TLC reference table that maps each `LocationID` to spatial taxi-zone metadata. The `Borough` or `Boro` field identifies the NYC borough or area where the zone is located, such as Manhattan, Brooklyn, Queens, Bronx, Staten Island, or EWR. The `Zone` field contains the official TLC taxi zone name. The `service_zone` field classifies the zone according to TLC service-area categories, such as Yellow Zone or Boro Zone. These fields are important for spatial forecasting because taxi demand varies strongly by location, land use, central business districts, airports, and borough-level travel patterns.

## 14. Weather Data Before/After Processing

Before/after weather figures are useful because they show the quality of weather data before it is merged into the modeling dataset. The before-processing figures should show raw hourly weather series, missing values, or raw distributions. The after-processing figures should show cleaned/interpolated weather series, derived weather indicators, and processed data availability. These figures provide evidence that weather data was cleaned consistently before integration with taxi demand records.

## 15. Outlier Detection

Suggested subsection:

> Outliers are observations that fall outside the expected or reasonable range for a variable. Taxi trip data can contain outliers because of data-entry errors, meter errors, cancelled trips, extremely short or long trips, invalid timestamps, unusual fare values, or invalid location identifiers. In this project, outlier detection removes records with invalid pickup/dropoff timestamps, unreasonable trip durations, unreasonable trip distances, invalid fare or total amount values, invalid passenger counts, and pickup/dropoff zones not found in the official TLC taxi-zone lookup. Removing these records improves model reliability because the model learns from realistic demand patterns instead of data errors or extreme records that do not represent normal taxi operations.

Placeholder to include in the report:

`[Insert before/after outlier table or figure showing removed rows by reason.]`
