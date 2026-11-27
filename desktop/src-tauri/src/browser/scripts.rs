//! JavaScript the core injects into the page. Every script returns a JSON string and catches its
//! own errors, because WebView2 and WKWebView drop the callback on an uncaught exception.

use serde_json::Value;

const FIND: &str = r#"
function find(a){
  if(a.ref){return document.querySelector('[data-trantor-ref="'+String(a.ref).replace(/"/g,'')+'"]');}
  if(a.selector){return document.querySelector(a.selector);}
  if(typeof a.x==='number'&&typeof a.y==='number'){return document.elementFromPoint(a.x,a.y);}
  return null;
}
function nameOf(e){
  var v=e.getAttribute('aria-label');
  if(!v){var ids=e.getAttribute('aria-labelledby');
    if(ids){v=ids.split(/\s+/).map(function(i){var x=document.getElementById(i);return x?x.textContent:'';}).join(' ');}}
  if(!v&&e.labels&&e.labels.length){v=Array.prototype.map.call(e.labels,function(l){return l.textContent;}).join(' ');}
  if(!v){v=e.innerText;}
  var ty=(e.getAttribute('type')||'').toLowerCase();
  if(!v&&(ty==='submit'||ty==='button'||ty==='reset')){v=e.value;}
  if(!v){v=e.getAttribute('placeholder')||e.getAttribute('title')||e.getAttribute('alt')||e.getAttribute('name');}
  return (v||'').replace(/\s+/g,' ').trim().slice(0,80);
}
"#;

fn wrap(args: &Value, body: &str) -> String {
    format!(
        "(function(a){{try{{{FIND}{body}}}catch(err){{return JSON.stringify({{ok:false,error:'not_found',message:String(err&&err.message||err)}});}}}})({args})"
    )
}

/// Tags interactive elements with data-trantor-ref and returns the page text and outline.
pub fn read(max_chars: usize) -> String {
    let body = r#"
var SEL='a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=textbox],[role=combobox],[onclick],[contenteditable=""],[contenteditable="true"]';
var n=window.__trantorRefN||0;var out=[];
function vis(e){var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0){return false;}var s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none';}
function role(e){
  var r=e.getAttribute('role');if(r){return r;}
  var t=e.tagName.toLowerCase();
  if(t==='a'){return 'link';}
  if(t==='button'||t==='summary'){return 'button';}
  if(t==='select'){return 'combobox';}
  if(t==='textarea'){return 'textbox';}
  if(t==='input'){var ty=(e.getAttribute('type')||'text').toLowerCase();
    if(ty==='checkbox'||ty==='radio'){return ty;}
    if(ty==='submit'||ty==='button'||ty==='reset'||ty==='image'){return 'button';}
    if(ty==='range'){return 'slider';}
    return 'textbox';}
  return 'generic';
}
var els=document.querySelectorAll(SEL);
for(var i=0;i<els.length&&out.length<500;i++){
  var e=els[i];if(!vis(e)){continue;}
  var ref=e.getAttribute('data-trantor-ref');
  if(!ref){ref='e'+(++n);e.setAttribute('data-trantor-ref',ref);}
  out.push({ref:ref,role:role(e),name:nameOf(e)});
}
window.__trantorRefN=n;
var text=document.body?(document.body.innerText||''):'';
return JSON.stringify({ok:true,url:location.href,title:document.title,text:text.slice(0,a.max),outline:out});
"#;
    wrap(&serde_json::json!({ "max": max_chars }), body)
}

pub fn click(target: &Value) -> String {
    let body = r#"
var el=find(a);
if(!el){return JSON.stringify({ok:false,error:'not_found',message:'nothing matches that target'});}
var byPoint=typeof a.x==='number'&&!a.ref&&!a.selector;
if(!byPoint&&el.scrollIntoView){el.scrollIntoView({block:'center',inline:'center'});}
var r=el.getBoundingClientRect();
var cx=byPoint?a.x:r.left+r.width/2,cy=byPoint?a.y:r.top+r.height/2;
function fire(type,C,down){el.dispatchEvent(new C(type,{bubbles:true,cancelable:true,composed:true,view:window,clientX:cx,clientY:cy,button:0,buttons:down?1:0,pointerId:1,pointerType:'mouse',isPrimary:true}));}
fire('pointerdown',window.PointerEvent||MouseEvent,true);
fire('mousedown',MouseEvent,true);
if(el.focus){el.focus();}
fire('pointerup',window.PointerEvent||MouseEvent,false);
fire('mouseup',MouseEvent,false);
fire('click',MouseEvent,false);
return JSON.stringify({ok:true,name:nameOf(el)});
"#;
    wrap(target, body)
}

pub fn type_text(target: &Value) -> String {
    let body = r#"
var el=find(a);
if(!el){return JSON.stringify({ok:false,error:'not_found',message:'nothing matches that target'});}
if(el.scrollIntoView){el.scrollIntoView({block:'center',inline:'center'});}
if(el.focus){el.focus();}
var tag=el.tagName;
if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'){
  var proto=tag==='TEXTAREA'?HTMLTextAreaElement.prototype:(tag==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype);
  var d=Object.getOwnPropertyDescriptor(proto,'value');
  if(d&&d.set){d.set.call(el,a.text);}else{el.value=a.text;}
}else if(el.isContentEditable){el.textContent=a.text;}
else{return JSON.stringify({ok:false,error:'not_found',message:'that element takes no text'});}
el.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:a.text}));
el.dispatchEvent(new Event('change',{bubbles:true}));
if(a.submit){
  ['keydown','keypress','keyup'].forEach(function(t){el.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));});
  var f=el.form;if(f){if(f.requestSubmit){f.requestSubmit();}else{f.submit();}}
}
return JSON.stringify({ok:true,name:nameOf(el)});
"#;
    wrap(target, body)
}

pub fn scroll(dy: f64) -> String {
    wrap(&serde_json::json!({ "dy": dy }), "window.scrollBy(0,a.dy);return JSON.stringify({ok:true,y:window.scrollY});")
}

/// Scrolls the element into view and returns its box in page-viewport coordinates.
pub fn element_rect(target: &Value) -> String {
    let body = r#"
var el=find(a);
if(!el){return JSON.stringify({ok:false,error:'not_found',message:'nothing matches that target'});}
if(el.scrollIntoView){el.scrollIntoView({block:'center',inline:'center'});}
var r=el.getBoundingClientRect();
return JSON.stringify({ok:true,rect:{x:r.left,y:r.top,w:r.width,h:r.height}});
"#;
    wrap(target, body)
}

/// Parses a script result. Some platforms hand back the JSON string, some a JSON-encoded string.
pub fn parse_result(raw: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    match v {
        Value::String(s) => serde_json::from_str(&s).ok(),
        other => Some(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_embed_arguments_as_json_not_as_code() {
        let evil = serde_json::json!({ "selector": "a'); alert(1); ('" });
        let s = click(&evil);
        assert!(s.ends_with(r#"({"selector":"a'); alert(1); ('"})"#));
        assert!(read(20000).contains(r#"({"max":20000})"#));
    }

    #[test]
    fn results_parse_whether_or_not_the_platform_double_encodes() {
        let plain = r#"{"ok":true,"n":1}"#;
        let encoded = serde_json::to_string(plain).expect("encode");
        assert_eq!(parse_result(plain), parse_result(&encoded));
        assert_eq!(parse_result(plain).and_then(|v| v["n"].as_i64()), Some(1));
        assert_eq!(parse_result(""), None);
    }
}
