export const formatConfigLogValue = (key: string, value: string) => (
  /token|password|secret|credential|proxy.*address/i.test(key) ? '[redacted]' : value
)
