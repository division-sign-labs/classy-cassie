# Adaptive calibration

Adding the Q–market gap modestly improved one-hour movement prediction in one chronological holdout. It did not clearly improve six-hour or 24-hour prediction. The result does not calibrate a profitable market-making strategy or justify larger tickets.

## Method

The source contains 992 forecasts from August 31 to September 5, 2026, with initial Q recovered from atomic publication artifacts. Each horizon uses timing-valid reference prices, available prior 24-hour volatility, entry prices between 5¢ and 95¢, and outcomes observed before market close.

One chronological 70/30 split was fixed per horizon. Training examples whose outcome horizon reached the test boundary were removed. Each event receives equal weight, divided equally among its markets and then among each market's forecasts.

The baseline is weighted linear least squares using prior 24-hour volatility, starting-price bucket, category, and time to close. The comparison adds only absolute Q–market gap. Both models receive the same feasible prediction bounds. There was no parameter search or repeated split selection.

The primary metric is holdout mean absolute error (MAE), in percentage points of reference-price movement. Lower is better. Uncertainty comes from 2,000 paired resamples of holdout events.

## Holdout

| Horizon | Training / test updates | Test events | Baseline MAE | With gap MAE | MAE change, 95% interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1h | 522 / 225 | 74 | 4.127 | 4.050 | −0.077 [−0.144, −0.012] |
| 6h | 487 / 214 | 71 | 7.029 | 7.069 | +0.040 [−0.017, +0.097] |
| 24h | 236 / 152 | 78 | 6.336 | 6.337 | +0.001 [−0.182, +0.184] |

The one-hour MAE improvement is approximately 1.9%. One-hour RMSE falls from 8.028pp to 7.905pp. Six-hour RMSE is essentially unchanged; 24-hour RMSE falls from 10.769pp to 10.654pp without improving MAE.

The horizon embargo removes zero, ten, and 116 training observations respectively. The one-hour sample already has a gap exceeding one hour before the test boundary. Every retained training outcome precedes the first test timestamp.

## Policy implications

The gap is a candidate incremental movement-risk input, not a replacement for recent activity and executable-book conditions. The fitted gap contribution is unstable across horizons: +0.68pp, −0.51pp, and +1.58pp of expected absolute movement per additional 10pp gap. These are diagnostic coefficients, not recommended quote shifts or widths.

The earlier full-sample association should not be presented as a calibrated live forecasting rule. This test does not support universal gap-based size increases. It does not establish an optimal spread, inventory target, forecast-age limit, or base ticket.

## Limitations

- The five-day dataset was already examined when developing the hypothesis. The test set is held out from fitting, not from hypothesis selection.
- This is one split. Intervals are not adjusted for testing three horizons and do not incorporate training-model uncertainty.
- Some markets and events recur across training and test. The embargo prevents overlapping labels; it does not produce an unseen-event evaluation.
- Absolute endpoint movement combines drift and uncertainty and misses price paths that move and return. It is not realized path volatility or residual variance.
- Reference prices are not executable historical bids and asks. Queue position, fills, adverse selection, fees, and spread capture are not tested.
- Initial publication Q precedes later coherence repairs. The test does not validate extrapolating the fitted relationship to older forecasts or the full served-Q revision history.
- Category and market-end metadata come from the retained graph snapshot.

## Reproduction

Run from the repository root with the existing analytics Python environment:

```sh
/Users/jordanolmstead/dev/quotient-analytics-pipelines/.venv/bin/python research/mm-strategy-review/adaptive-calibration.py
```

The script reads the saved research dataset and writes `adaptive-calibration.json`. It makes no network requests and does not read credentials or change bot configuration.
