# Disposable, offline unit-test toolchain. Source is supplied at runtime.
# TEST_BASE_IMAGE may reuse a reviewed runtime image with the same frozen deps.
ARG TEST_BASE_IMAGE=oven/bun:1.3.13
FROM ${TEST_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git jq procps util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
# Never run the product postinstall against a brain during image construction.
RUN if [ ! -d node_modules ]; then bun install --frozen-lockfile --ignore-scripts --no-progress; fi
# Reused runtime images must not probe a service this test image never starts.
HEALTHCHECK NONE
ENTRYPOINT ["bash"]
