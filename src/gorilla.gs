require! './parser'
require! os
require! fs
require! path
require! SourceMap: './source-map'
let {write-file-with-mkdirp, write-file-with-mkdirp-sync} = require('./utils')

const DEFAULT_TRANSLATOR = './jstranslator'

exports.version := __VERSION__
exports <<< {parser.ParserError, parser.MacroError}

// TODO: Remove register-extension when fully deprecated.
if require.extensions
  require.extensions[".gs"] := #(module, filename)
    let compiled = exports.compile-sync fs.read-file-sync(filename, "utf8"), { filename }
    module._compile compiled.code, filename
else if require.register-extension
  require.register-extension ".gs", #(content) -> exports.compile-sync content, { filename }

let fetch-and-parse-prelude = do
  let parsed-prelude-by-lang = {}
  let real-__filename = if __filename? then fs.realpath-sync(__filename)
  let get-prelude-src-path = if real-__filename? then #(lang) -> path.join(path.dirname(real-__filename), "../src/$(lang)prelude.gs")
  let get-prelude-cache-path = if os? then #(lang) -> path.join(os.tmp-dir(), "gs-$(lang)prelude-$(exports.version).cache")
  let prelude-promises-by-lang = {}
  let work = promise! #(lang as String, sync)*
    let prelude-src-path = get-prelude-src-path(lang)
    let prelude-src-stat = if sync
      fs.stat-sync prelude-src-path
    else
      yield to-promise! fs.stat prelude-src-path
    
    let prelude-cache-path = get-prelude-cache-path(lang)
    let mutable prelude-cache-stat = void
    try
      prelude-cache-stat := if sync
        fs.stat-sync prelude-cache-path
      else
        yield to-promise! fs.stat prelude-cache-path
    catch e
      if e.code != "ENOENT"
        throw e
    
    let mutable parsed-prelude = void
    if prelude-cache-stat and prelude-src-stat.mtime.get-time() <= prelude-cache-stat.mtime.get-time()
      let cache-prelude = if sync
        fs.read-file-sync prelude-cache-path, "utf8"
      else
        yield to-promise! fs.read-file prelude-cache-path, "utf8"
      let mutable errored = false
      try
        parsed-prelude := parsed-prelude-by-lang[lang] := parser.deserialize-prelude(cache-prelude)
      catch e as ReferenceError
        throw e
      catch e
        console.error "Error deserializing prelude, reloading. $(String e)"
        errored := true
      if errored
        if sync
          fs.unlink-sync prelude-cache-path
        else
          yield to-promise! fs.unlink prelude-cache-path
    if not parsed-prelude?
      let prelude = if sync
        fs.read-file-sync prelude-src-path, "utf8"
      else
        yield to-promise! fs.read-file prelude-src-path, "utf8"
      parsed-prelude := parsed-prelude-by-lang[lang] := if sync
        parser.sync prelude, null, { +serialize-macros, +sync }
      else
        yield parser prelude, null, { +serialize-macros }
      fs.write-file prelude-cache-path, parsed-prelude.macros.serialize(), "utf8", #->
    delete prelude-promises-by-lang[lang]
    return parsed-prelude
  let f(lang as String, sync as Boolean)
    let parsed-prelude = parsed-prelude-by-lang![lang]
    if parsed-prelude?
      if sync
        parsed-prelude
      else
        fulfilled! parsed-prelude
    else
      if sync
        work.sync lang, true
      else
        prelude-promises-by-lang[lang] ?= work lang
  
  f.serialized := promise! #(lang as String)*
    yield f(lang)
    return yield to-promise! fs.read-file get-prelude-cache-path(lang), "utf8"
  
  exports.with-prelude := #(lang as String, serialized-prelude as {})
    parsed-prelude-by-lang[lang] := parser.deserialize-prelude(serialized-prelude)
    this
  f

exports.get-serialized-prelude := fetch-and-parse-prelude.serialized

exports.parse := promise! #(source, options = {})*
  let sync = options.sync
  let macros = if options.macros
    options.macros
  else if options.no-prelude
    null
  else if sync
    fetch-and-parse-prelude(options.lang or "js", true).macros
  else
    (yield fetch-and-parse-prelude(options.lang or "js")).macros
  
  let parse-options = {
    options.filename
    noindent: not not options.noindent
    embedded: not not options.embedded
    embedded-unpretty: not not options.embedded-unpretty
    embedded-generator: not not options.embedded-generator
    sync: not not options.sync
    options.progress
  }
  if sync
    parser.sync(source, macros, parse-options)
  else
    yield parser(source, macros, parse-options)
exports.parse-sync := #(source, options = {})
  exports.parse.sync source, {} <<< options <<< {+sync}

exports.get-reserved-words := #(options = {})
  if options.no-prelude
    parser.get-reserved-words(null, options)
  else
    parser.get-reserved-words(fetch-and-parse-prelude(options.lang or "js", true).macros, options)

let join-parsed-results(results)
  let joined-parsed = {
    parse-time: 0
    macro-expand-time: 0
    reduce-time: 0
    results[0].macros
    result: []
  }
  for parsed in results
    joined-parsed.parse-time += parsed.parse-time
    joined-parsed.macro-expand-time += parsed.macro-expand-time
    joined-parsed.reduce-time += parsed.reduce-time
    joined-parsed.result.push parsed.result
  joined-parsed

exports.ast := promise! #(source, options = {})*
  let start-time = new Date().get-time()
  let sync = options.sync
  let translator = if is-function! options.translator
    options.translator
  else 
    require(if is-string! options.translator then options.translator else DEFAULT_TRANSLATOR)
  
  let parsed = if is-array! source
    let array = []
    let original-progress = options.progress
    let progress-counts = {parse: 0, macro-expand: 0, reduce: 0}
    if is-function! original-progress
      options.progress := #(name, time)
        progress-counts[name] += time
    for item in source
      if is-array! options.filenames
        options.filename := options.filenames[i]
      array.push if sync
        exports.parse-sync item, options
      else
        yield exports.parse item, options
    options.progress := original-progress
    if is-function! original-progress
      for name in [\parse, \macro-expand, \reduce]
        options.progress name, progress-counts[name]
    join-parsed-results array
  else
    if sync
      exports.parse-sync source, options
    else
      yield exports.parse source, options
  let translated = translator(parsed.result, parsed.macros, parsed.get-position, options)
  
  return {
    translated.node
    parsed.parse-time
    parsed.macro-expand-time
    parsed.reduce-time
    translate-time: translated.time
    time: new Date().get-time() - start-time
  }
exports.ast-sync := #(source, options = {})
  exports.ast.sync source, {} <<< options <<< {+sync}

exports.compile := promise! #(source, options = {})*
  let sync = options.sync
  let start-time = new Date().get-time()
  let translated = if sync
    exports.ast-sync source, options
  else
    yield exports.ast source, options
  let compiled = translated.node.compile options
  return {
    translated.parse-time
    translated.macro-expand-time
    translated.reduce-time
    translated.translate-time
    compiled.compile-time
    compiled.uglify-time
    time: new Date().get-time() - start-time
    compiled.code
  }
exports.compile-sync := #(source, options = {})
  exports.compile.sync source, {} <<< options <<< {+sync}

exports.compile-file := promise! #(mutable options = {})!*
  options := {} <<< options
  let sync = options.sync
  let mutable inputs = options.input
  if is-string! inputs
    inputs := [inputs]
  else if not is-array! inputs
    throw Error "Expected options.input to be a string or array of strings"
  else if inputs.length == 0
    throw Error "Expected options.input to not be empty"
  let output = options.output
  if not is-string! output
    throw Error "Expected options.output to be a string, got $(typeof! output)"
  let mutable source-map-file = void
  if not options.source-map
    options.source-map := null // in case it was set to a falsy value
  else if is-string! options.source-map
    source-map-file := options.source-map
    options.source-map := SourceMap(options.output, "")
  else
    if not is-string! options.source-map.file
      throw Error "Expected options.sourceMap.file to be a string, got $(typeof! options.source-map.file)"
    if not is-string! options.source-map.source-root
      throw Error "Expected options.sourceMap.sourceRoot to be a string, got $(typeof! options.source-map.source-root)"
    source-map-file := options.source-map.file
    options.source-map := SourceMap(options.output, options.source-map.source-root)
  let mutable sources = []
  if sync
    for input in inputs
      sources.push fs.read-file-sync input, "utf8"
  else
    sources := yield promisefor(5) input in inputs
      yield to-promise! fs.read-file input, "utf8"
  let original-progress = sources.length > 0 and options.progress
  let progress-counts = {parse: 0, macro-expand: 0, reduce: 0}
  if is-function! original-progress
    options.progress := #(name, time)
      progress-counts[name] += time
  let parsed = for source, i in sources
    let start-parse-time = Date.now()
    options.filename := inputs[i]
    if sync
      exports.parse-sync source, options
    else
      yield exports.parse source, options
  if is-function! original-progress
    options.progress := original-progress
    for name in [\parse, \macro-expand, \reduce]
      options.progress name, progress-counts[name]
  // FIXME: only using macros from the first parsed source, which is most likely wrong.
  // Only the helpers need to be exposed to the translator, as it no longer cares for the rest of the
  // macro system.
  options.filenames := inputs
  let translator = require('./jstranslator')
  let translated = translator(
    (for x in parsed; x.result)
    parsed[0].macros
    (for x in parsed; x.get-position)
    options)
  let compiled = translated.node.compile options
  unless sync
    yield delay! 0
  let mutable code = compiled.code
  if source-map-file
    let linefeed = options.linefeed or "\n"
    let footer = "$(linefeed)/*$(linefeed)//@ sourceMappingURL=$(path.relative path.dirname(options.output), source-map-file)$(linefeed)*/$(linefeed)"
    code &= footer
  if sync
    write-file-with-mkdirp-sync options.output, code, options.encoding or "utf8"
  else
    yield write-file-with-mkdirp options.output, code, options.encoding or "utf8"
  if source-map-file
    // don't use options.encoding for source-maps, as in the spec, it's always utf8
    if sync
      write-file-with-mkdirp-sync source-map-file, options.source-map.to-string(), "utf8"
    else
      yield write-file-with-mkdirp source-map-file, options.source-map.to-string(), "utf8"
exports.compile-file-sync := #(options = {})
  exports.compile-file.sync {} <<< options <<< {+sync}

let evaluate(code, options)
  let Script = require?('vm')?.Script
  if Script
    let mutable sandbox = Script.create-context()
    sandbox.global := sandbox.root := sandbox.GLOBAL := sandbox
    if options.sandbox?
      if options.sandbox instanceof sandbox.constructor
        sandbox := options.sandbox
      else
        for k, v of options.sandbox
          sandbox[k] := v
    else
      for k, v of GLOBAL
        sandbox[k] := v
    sandbox.__filename := options.filename or "eval"
    sandbox.__dirname := path.dirname sandbox.__filename
    if not sandbox.module and not sandbox.require
      let Module = require "module"
      let _module = sandbox.module := new Module(options.modulename or "eval")
      let _require = sandbox.require := #(path) -> Module._load path, _module
      _module.filename := sandbox.__filename
      for r in Object.get-own-property-names(require) by -1
        try
          _require[r] := require[r]
        catch e
          void
    if options.include-globals
      for k of GLOBAL
        if sandbox not haskey k
          sandbox[k] := GLOBAL[k]
    Script.run-in-context code, sandbox
  else
    let fun = Function("return $code")
    fun()

exports.eval := promise! #(source, options = {})*
  let sync = options.sync
  options.eval := true
  options.return := false
  let compiled = if sync
    exports.compile-sync source, options
  else
    yield exports.compile source, options
  
  let start-time = new Date().get-time()
  let result = evaluate compiled.code, options
  options.progress?(\eval, new Date().get-time() - start-time)
  return result

exports.eval-sync := #(source, options = {})
  exports.eval.sync source, {} <<< options <<< {+sync}

exports.run := promise! #(source, options = {})*
  let sync = options.sync
  if is-void! process
    return if sync
      exports.eval-sync(source, options)
    else
      yield exports.eval(source, options)
  let main-module = require.main
  main-module.filename := (process.argv[1] := if options.filename
    fs.realpath-sync(options.filename)
  else
    ".")
  main-module.module-cache and= {}
  if process.binding('natives').module
    let {Module} = require('module')
    main-module.paths := Module._node-module-paths path.dirname options.filename
  if path.extname(main-module.filename) != ".gs" or require.extensions
    let compiled = if sync
      exports.compile-sync source, options
    else
      yield exports.compile source, options
    main-module._compile compiled.code, main-module.filename
  else
    main-module._compile source, main-module.filename
exports.run-sync := #(source, options = {})
  exports.run.sync source, {} <<< options <<< {+sync}

let init = exports.init := promise! #(options = {})*
  if options.sync
    fetch-and-parse-prelude(options.lang or "js", true)
  else
    yield fetch-and-parse-prelude(options.lang or "js")
exports.init-sync := #(options = {})!
  init.sync {} <<< options <<< {+sync}