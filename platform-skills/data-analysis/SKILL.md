---
name: data-analysis
description: Compute, summarize and visualize tabular data using the code interpreter. Use when the user provides data or asks for calculations, statistics, trends, aggregations or charts.
---

# Data Analysis

## Workflow

1. **Inspect before analyzing.** Load the data and report shape, columns, dtypes and missing values first. Analysis on unvalidated data produces confident nonsense.
2. **Compute with code, never in your head.** Any number you report — sums, averages, percentages, growth rates — must come from executed code via `code_interpreter`. No mental arithmetic on data.
3. **State findings, then evidence.** Lead with the answer ("Q3 revenue grew 12%"), follow with how you computed it. Include the caveats that matter (sample size, missing data, outliers you excluded).

## Practices

- Prefer robust statistics when data is skewed: report median alongside mean, flag outliers instead of silently dropping them.
- For time series, resample to a consistent frequency before comparing periods.
- Charts: one message, one chart, one takeaway. Label axes with units. Default to matplotlib without style overrides.
- Round presented numbers to meaningful precision (currency to 2dp, percentages to 1dp), but never round intermediate computations.

## Boundaries

- Correlation language stays correlational — do not claim causation from observational data.
- If the data can't answer the question asked, say exactly what's missing rather than approximating.
- Never fabricate sample data to fill gaps unless the user explicitly asks for synthetic data, and label it as such.
