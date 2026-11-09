# gaussian-mixture-viz

An interactive visualizer for a **mixture of Gaussians**.

Pick **n = 2–5** components, set a **weight**, **μ** and **σ** for each one, and see:
- the combined density f(x) = Σ wᵢ·N(x; μᵢ, σᵢ), with each weighted component underneath
- the cumulative distribution F(x) = Σ wᵢ·Φ((x − μᵢ)/σᵢ)
- summary stats: mean, standard deviation, median, number of peaks

Weights are normalized so they always sum to 1.

## Run locally
Open `index.html` in a browser. No build step needed.
