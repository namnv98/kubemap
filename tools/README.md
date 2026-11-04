# Dev tools

- `testdata/*.yaml` — test workloads in 8 namespaces (shop, shop-staging, blog, observability, batch, messaging, auth, payments;
  `payments` is broken on purpose: ImagePullBackOff, CrashLoop, Pending, missing ConfigMap, PVC without StorageClass).
  `kubectl apply -f tools/testdata/`
- `describe_vs_kubectl.py` — line-by-line comparison of the Describe tab with `kubectl describe` (kubectl 1.36 is the reference).
  `KUBECONFIG=... python3 tools/describe_vs_kubectl.py --all` or `... Pod shop <name> -v` for the diff of one object.
  Ages are normalised (the two calls run a moment apart).
- `cdp.mjs` — drive headless Chrome over DevTools: `node tools/cdp.mjs <url> <out.png> '<js run in the page>' [waitMs]`,
  prints the JS result and saves a screenshot. Used to check the UI without a browser extension.
