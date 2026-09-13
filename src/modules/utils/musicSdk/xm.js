const xm = {
  getMusicUrl() {
    return {
      promise: Promise.reject(new Error('fail')),
    }
  },
  getLyric() {
    return {
      promise: Promise.reject(new Error('fail')),
    }
  },
  getPic() {
    return Promise.reject(new Error('fail'))
  },
}

export default xm
