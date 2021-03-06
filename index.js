var crypto = require('crypto')
var fs = require('fs')
var stream = require('stream')
var util = require('util')
var zlib = require('zlib')
var blake2b = require('blake2b-wasm')
var pump = require('pump')
var tar = require('tar-fs')

function noop () {}

function stat (entry, opts, cb) {
  opts.dereference ? fs.stat(entry, cb) : fs.lstat(entry, cb)
}

function xor (a, b) {
  var len = Math.max(a.length, b.length)
  var buf = Buffer.alloc(len)
  for (var i = 0; i < len; i++) buf[i] = a[i] ^ b[i]
  return buf
}

function PipeHash (opts, callback) {
  if (!(this instanceof PipeHash)) return new PipeHash(opts, callback)
  stream.Transform.call(this)

  if (typeof opts === 'function') {
    callback = opts
    opts = {}
  }

  if (!callback) callback = noop
  if (!opts) opts = {}

  this._opts = {}

  // hash: custom std crypto hash, or 1st default blake2b, 2nd default sha512
  this._opts.hash = opts.hash || (blake2b.SUPPORTED ? 'blake2b' : 'sha512')
  this._blake2b = this._opts.hash === 'blake2b'
  this._blake2b_READY = false
  this._opts.blake2bArgs = [
    opts.blake2bDigestLength || 64,
    opts.blake2bKey || null,
    opts.blake2bSalt || null,
    opts.blake2bPersonal || null
  ]

  this._opts.windowSize = 1024 * (opts.windowKiB || 64) // 64KiB by default
  this._window = Buffer.alloc(this._opts.windowSize)    // window
  this._offset = 0                                      // write offset in win
  this._accu = Buffer.alloc(0)                          // rolling hash buffer

  this.on('finish', function () { // total stream payload shorter than win?
    this._done(callback)
  })

  var self = this

  if (this._blake2b) {
    blake2b.ready(function (err) {
      if (err) throw err
      self._blake2b_READY = true
    })
  }

}

util.inherits(PipeHash, stream.Transform)

PipeHash.prototype._transform = function transform (chunk, _, next) {
  this.push(chunk) // passthru
  this._process(chunk)
  next()
}

PipeHash.prototype._process = function process (chunk) {
  var start = this._opts.windowSize - this._offset
  var numChops = Math.ceil(chunk.length / this._opts.windowSize)
  var end

  if (chunk.length > start) {
    this._offset += chunk.slice(0, start).copy(this._window, this._offset)
    this._maybeHashAndClear()
    for (var i = 1; i < numChops; i++) {
      end = start + this._opts.windowSize
      this._offset += chunk.slice(start, end).copy(this._window, this._offset)
      this._maybeHashAndClear()
      start = end
    }
  } else {
    this._offset += chunk.copy(this._window, this._offset)
    this._maybeHashAndClear()
  }
}

PipeHash.prototype._maybeHashAndClear = function maybeHashAndClear () {
  if (this._offset === this._opts.windowSize) {
    this._accu = xor(this._accu, this._hash(this._window))
    this._clear()
  }
}

PipeHash.prototype._hash = function hash (buf) {
  if (this._blake2b && this._blake2b_READY) {
    return blake2b.apply(null, this._opts.blake2bArgs).update(buf).digest()
  } else if (!this._blake2b) {
    return crypto.createHash(this._opts.hash).update(buf).digest()
  } else {
    throw Error('blake2b-wasm module is not ready yet :(')
  }
}

PipeHash.prototype._clear = function clear (everything) {
  if (everything) this._accu = Buffer.alloc(0)
  this._window.fill(0x00)
  this._offset = 0
}

PipeHash.prototype._done = function done (callback) {
  if (!this._accu.length) this._accu = this._hash(this._window)
  var fingerprint = Buffer.from(this._accu)
  this._clear(true)
  this.emit('fingerprint', fingerprint)
  callback(null, fingerprint)
}

PipeHash.prototype.fingerprint = function fingerprint (file, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts
    opts = {}
  }

  if (!opts) opts = {}
  if (!callback) callback = noop

  var self = this

  stat(file, opts, function (err, stats) {
    if (err) return callback(err)

    var tail
    var readStream

    if (stats.isDirectory()) readStream = tar.pack(file)
    else if (stats.isFile()) readStream = fs.createReadStream(file)
    else callback('unsupported resource')

    if (opts.gzip !== false) {
      tail = zlib.createGzip()
      pump(readStream, tail)
    } else {
      tail = readStream
      tail.on('error', tail.destroy)
      tail.on('end', tail.destroy)
    }

    tail.on('data', function (chunk) {
      self._process(chunk)
    })

    tail.on('end', function () {
      self._done(callback)
    })

  })

}

module.exports = PipeHash
