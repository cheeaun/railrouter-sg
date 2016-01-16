var process = require('process');
var fs = require('fs');
var cheerio = require('cheerio');
var JSON5 = require('json5');
var CleanCSS = require('clean-css');
var UglifyJS = require('uglify-js');

var input = process.argv[2];
var output = process.argv[3];

var html = fs.readFileSync(input, 'utf8');
var $ = cheerio.load(html);

$('inline-json').each(function(){
  var el = $(this);
  var src = el.attr('src');
  var variable = el.attr('variable');
  var json = fs.readFileSync(src, 'utf8');
  var minifiedJSON = JSON5.stringify(JSON.parse(json));
  el.replaceWith('<script>var ' + variable + '=' + minifiedJSON + '</script>');
});

$('link[rel=stylesheet]').each(function(){
  var el = $(this);
  var href = el.attr('href');
  var css = fs.readFileSync(href, 'utf8');
  var minifiedCSS = new CleanCSS().minify(css).styles;
  el.replaceWith('<style>' + minifiedCSS + '</style>');
});

$('script').each(function(){
  var el = $(this);
  var src = el.attr('src');
  if (!src || /^http/i.test(src)) return; // Only accept local files
  var js = fs.readFileSync(src, 'utf8');
  var result = UglifyJS.minify(js, {fromString: true});
  el.replaceWith('<script>' + result.code + '</script>');
});

var htmlString = $.html();
htmlString = htmlString.replace(/([^>])<\/script>[\s\n\r\t]*<script>/ig, '$1\n');

fs.writeFile(output, htmlString, function(e){
  if (e) throw e;
  console.log('HTML file generated: ' + output);
});
