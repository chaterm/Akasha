# Local PostgreSQL aligned with the cloud database:
#   PostgreSQL 18 + pgvector + pg_trgm + pg_jieba (Chinese full-text search).
# Pinned commits keep jieba segmentation identical across environments.
ARG PG_IMAGE=pgvector/pgvector:pg18-trixie

FROM ${PG_IMAGE} AS build
ARG PG_JIEBA_COMMIT=d0ffac8028328b2566a889ff4db3d74ba63d1b42
ARG CPPJIEBA_COMMIT=391121d5db0f31dd5ce9795d4d34812f20eeb25c
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential cmake git ca-certificates postgresql-server-dev-18 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone https://github.com/jaiminpan/pg_jieba.git \
  && cd pg_jieba \
  && git checkout "${PG_JIEBA_COMMIT}" \
  && git clone https://github.com/yanyiwu/cppjieba.git libjieba \
  && cd libjieba && git checkout "${CPPJIEBA_COMMIT}" \
  && git submodule update --init --recursive
RUN cd pg_jieba && mkdir build && cd build \
  && cmake -DPostgreSQL_TYPE_INCLUDE_DIR=/usr/include/postgresql/18/server .. \
  && make -j"$(nproc)" \
  && make install DESTDIR=/out

FROM ${PG_IMAGE}
COPY --from=build /out/usr/ /usr/
# Preload so the ~110 MB jieba dictionary is loaded once by the postmaster
# and shared by forked backends instead of being loaded per connection.
CMD ["postgres", "-c", "shared_preload_libraries=pg_jieba"]
