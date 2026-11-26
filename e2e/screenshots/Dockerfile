ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apk add --no-cache py3-matplotlib py3-matplotlib-tk
COPY --chown=e2e:e2e screenshots/waves.py /home/e2e/waves.py
