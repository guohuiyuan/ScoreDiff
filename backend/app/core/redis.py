import fakeredis.aioredis

redis_client = fakeredis.aioredis.FakeRedis(decode_responses=True)
