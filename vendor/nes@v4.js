!function(win, doc){

  // ##简介
  // 源码重构了两次，现在除了一两个主处理函数，所有函数都低于20行
  // 完全的__面向过程__编程，不喜勿喷，通常你可以在调用函数的附近找到被调用函数
  // 整个实现过程你可以找到一点点解析生成的感觉，因为整个选择器都是动态的
  // 连parser也是
  
  // __nes__: 命名空间
  // 本来想做个Wrapper类(类JQeruy)，想想还是做个纯粹的选择器吧
  // nes目前仅作为all方法的alias
  var nes = function(sl,context){return new NES(sl, context)},
    prevNes = win.nes

  nes.version = "0.0.4"
  var 
    // 常用属性local化
    ap = Array.prototype,
    op = Object.prototype,
    sp = String.prototype,
    fp = Function.prototype,
    slice = ap.slice,
    body = doc.body,
    testNode = doc.createElement("div"),
    // ###Helper(助手函数)

    // 够用的短小类型判断 
    typeOf = function(o){
      return o == null? String(o) : 
                op.toString.call(o).slice(8, -1).toLowerCase()
    },
    // 够用的简单对象扩展
    extend = function(o1, o2, override){
      for(var i in o2){
        if(o1[i] == null || override) o1[i] = o2[i]
      }
    },
    // 将类数组(如Nodelist、Argument)变为数组
    toArray = function(arr){
      return slice.call(arr)
    },
    // 让setter型函数fn支持object型的参数 
    // 即支持`set(name:value)` 
    // 也支持`set({name1:value1,name2:value2})`
    autoSet = function(fn){
      return function(key, value) {
        if (typeOf(key) == "object") {
          for (var i in key) {
            fn.call(this, i, key[i])
          }
        } else {
          fn.call(this, key, value)
        }
        return this;
      }
    },
    // 先进先出缓存队列, max设置最大缓存长度, 为了不必要重复parse
    // nes会多次用到这个方法创建cache
    createCache = function(max){
      var keys = [],
        cache = {}
        return {
          set:function(key , value){
            if(keys.length > this.length){
              delete cache[keys.shift()]
            }
            cache[key] = value
            keys.push(key)
            return value
          },
          get:function(key){
            if(typeof key === "undefined") return cache
            return cache[key]
          },
          // 这个方法返回的对象有length属性，
          // 你可以通过设置这个length后续调整缓存大小
          length:max
        }
    }
  // Fixed: toArray 低于IE8的 Nodelist无法使用slice获得array
  try{
    slice.call(doc.getElementsByTagName("body"))
  }catch(e){
    toArray = function(arr){
      var result = [],len=arr.length
      for(var i =0;i<len;i++){
        result.push(arr[i])
      }
      return result
    }
  }

  // 扩展ES5 Native支持的函数，坑爹的远古浏览器

  //es5 trim
  var trimReg = /^\s+|\s+$/g
  sp.trim = sp.trim || function(){
    return this.replace(trimReg, "")
  }
  //es5 bind
  fp.bind = fp.bind || function(context, args) {
    args = slice.call(arguments, 1);
    var fn = this;
    return function() {
        fn.apply(context, args.concat(slice.call(arguments)));
    }
  }
  //es5 Array indexOf
  ap.indexOf = ap.indexOf || function(a) {
    for (var i = 0, len = this.length; i < len; i++) {
      if (a === this[i]) return i
    }
    return -1
  } 

  // ## Parse 开始

  // 与parse部分关系紧密的属性在这里定义,
  // 首先是一些parse会用到的但是不是语法组成部分的RegExp，

  var 
    replaceReg = /\{\{([^\}]*)\}\}/g, //替换rule中的macro
    esReg = /[-[\]{}()*+?.\\^$|,#\s]/g, //需转移字符
    nthValueReg = /^(?:(\d+)|([+-]?\d*)?n([+-]\d+)?)$/,// nth伪类的value规则
    posPesudoReg =  /^(nth)[\w-]*(-of-type|-child)/, //判断需要pos

    // ### TRUNK
    // 所有的语法最后都会组装到这个TRUNK变成一个巨型RegExp  
    TRUNK = null, 

    // 第一个cache 用来装载nth伪类中的参数解析后的数据
    // 如nth-child、nth-of-type等8个伪类
    nthCache = createCache(100),
    // 提取nthValue中的有用信息 比如an + b 我们需要提取出a以及,b并对额外情况如缺少a参数或b参数
    // 或者有a、b小于0这些情况作统一处理，返回find适合使用的数据
    extractNthValue = function(param){
     var step,start,res
      //如果无参数 当成是获取第一个元素
      if(!param || !(param = param.replace(/\s+/g,""))){
        return {start:1, step:0 }
      }
      if(res = nthCache.get(param)) return res
      // 对even odd等转化为标准的a，b组合(即step与start)
      if(param == "even"){
        start = 2
        step = 2
      }else if(param == "odd"){
        step = 2
        start = 1
      }else{
        res = param.match(nthValueReg)
        // 对错误的nth参数抛出错误
        if(!res) step = null  // 无论其他参数，如果step为null，则永远为false
        else{
          if(res[1]){
            step = 0
            start = parseInt(res[1])
          }else{
            if(res[2] == "-") res[2] ="-1"
            step = res[2]? parseInt(res[2]) :1
            start = res[3]? parseInt(res[3]):0
          }
        }
      }
      if(start<1){
        if(step <1){
          step = null //标志false
        }else{
          start = -(-start)%step +step
        }
      } 
      return nthCache.set(param,{start:start,step:step})
    }

  // ### parse Rule 相关
  // 了解bison等解析生成的同学可以把这部分看成是词法与语法定义的杂糅
  // 很混乱不标准，但对于选择器这种最简单的DSL其实并不难懂
  // 整个Parser根据rules动态产生(即可在使用时发生改变)

  // 具体的流程是下面的rules对象定义了一组语法(词法?)rule——如attribute，
  // 你可以把每个rule中的reg想象成一个token(word?),这些token可能会有{{word}}这种占位符
  // 占位符首先会被macros中对应的macro替换，然后这些token会被组装成一个大版的Regexp，即上面的
  // Trunk变量,这个过程没什么特殊，一般比较优秀的选择器都是基于这个方法。 在nes中,最终的Trunk可能是
  // 这样的:
  //
  // `/(\s*,\s*)|(#([\w\u4e00-\u9fbf-]+))|(\*|\w+)|(\.([\w\u4e00-\u9fbf-]+))|
  // (:([\w\u4e00-\u9fbf-]+)(?:\(([^\(\)]*|(?:\([^\)]+\)|[^\(\)]*)+)\))?)|
  // (\[([\w\u4e00-\u9fbf-]+)(?:([*^$|~!]?=)['"]?((?:[\w\u4e00-\u9fbf-]||\s)+)['"]?)?\])|(::([\w\u4e00-\u9fbf-]+))
  // |([>\s+~&%](?!=))|(\s*\{\s*(\d*),(\-?\d*)\s*\}\s*)/g`
  // 
  // 看到上面那长串，你大概理解了将regexp按词法分开这样做的第一个原因 : __维护__. 神奇的部分在下面会描述
  var 
    // 一些macro
    macros = {
      split:"\\s*,\\s*", // 分隔符
      operator: "[*^$|~!]?=", // 属性操作符 如= 、!=
      combo: "[>\\s+~](?!=)", // 连接符 如 > ~ 
      // 中文unicode范围http://baike.baidu.com/view/40801.htm#sub40801_3
      word: "[\\w\\u4e00-\\u9fbf-]"
    },
    // 语法规则定义
    rules = {
      split:{
        // 分隔符 如 ，
        reg:"{{split}}",
        action:function(all){
          var data = this.data
          data.push([null])
        }
      },
      // id 如 #home
      id:{
        reg:"#({{word}}+)",
        action:function(all, id){
          this.current().id = id
        }
      },
      // 节点类型选择符 如 div
      tag:{
        reg:"\\*|\\w+",// 单纯的添加到
        action:function(all){
          this.current().tag = all.toLowerCase()
        }
      },
      // 类选择符 如 .m-home
      classList:{
        reg:"\\.({{word}}+)",
        action:function(all, className){
          var current = this.current(),
            classList = current.classList || (current.classList = [])
          classList.push(className)
        }
      },
      // 伪类选择符 如 :nth-child(3n+4)
      pesudos:{
        reg:":({{word}}+)" +                 //伪类名
          "(?:\\("+                  //括号开始
            "([^\\(\\)]*" +      //第一种无括号
            "|(?:" +                  //有括号(即伪类中仍有伪类并且是带括号的)
              "\\([^\\)]+\\)" +             //括号部分
              "|[^\\(\\)]*" +              
            ")+)" +                    //关闭有括号
          "\\))?",                   // 关闭最外圈括号
        action:function(all, name, param){
          var current = this.current(),
          pesudos = current.pesudos || (current.pesudos = [])

          if(param) param = param.trim()
          if(posPesudoReg.test(name)){
            // parse 的成本是很小的 尽量在find前把信息准备好
            // 这里我们会把nth-child(an+b) 的 a 与 b 在不同输入下标准化
            param = extractNthValue(param) 
          }
          pesudos.push({name:name,param:param})
        }
      },
      // 属性选择符  如  [class=hahaha]
      //
      // 这里以属性选择符为例，说明下reg与action的关系
      // 
      attributes:{
        reg:"\\[({{word}}+)(?:({{operator}})[\'\"]?((?:{{word}}||\\s)+)[\'\"]?)?\\]",
        action:function(all, key, operator, value){
          var current = this.current(),
          attributes = current.attributes || (current.attributes = [])
          attributes.push({key:key,operator:operator,value:value})
        }
      },
      // 伪元素可以实现么？ 占位
      combo:{
        reg:"{{combo}}",
        action:function(all){
          var data = this.data
            cur = data[data.length-1]
          this.current().combo = all
          cur.push(null)
        }
      }
    },
    links={} // symbol link 当setup之后会产生一个map来实现exec之后的参数对应

  //分析出regexp中的子匹配数，__参数定位关键之一__
  var ignoredReg = /\(\?\!|\(\?\:/
  var extractReg = function(regStr){
    var left = right = 0,len = regStr.length
      ignored = regStr.split(/\(\?\!|\(\?\:/).length-1//忽略非捕获匹配

    for(;len--;){
      var letter = regStr.charAt(len)
      if(len==0 || regStr.charAt(len-1)!=="\\"){ //不包括转义括号
        if(letter === "(") left++
        if(letter === ")") right++
      }
    }
    if(left !== right) throw regStr+"中的括号不匹配"
    else return left - ignored
  }
  //这里替换掉Rule中的macro
  var cleanRule = function(rule){
    var reg = rule.reg
    //如果已经是regexp了就转为string
    if(typeOf(reg) === "regexp") reg = reg.toString().slice(1,-1) 
    //将macro替换
    rule.regexp = reg.replace(replaceReg, function(a ,b){
      if(b in macros) return macros[b]
      else throw new Error('can"t replace undefined macros:' +b)
    })
    return rule
  }
  var cleanRules = function(rules){
    for(var i in rules){
      if(rules.hasOwnProperty(i)) cleanRule(rules[i])
    }
    return rules
  }

  // API: 1. addRule         
  // ----------------
  // 自定义规则, 增加全新语法
  // __options:__
  // 1. name{string} 虽然可以随机生成，但是为了可维护起见，我改成了必须实名
  // 2. rule 规则对象它包括
  //    * reg{string|regexp}:    规则的标准RegExp表达 __不可忽略__
  //    * action: parse时的动作 参数与__reg__相关(exec后的匹配) __可忽略__
  //    * filter: find时的过滤操作 参数与__action__有关 __可忽略__
  // 
  // 具体例子可以参考上方的rules对象,需要说明的是action回调中的this对象指向parsed
  // data对象,而filter中的node参数为当前遍历到的node
  var addRule = addRule = function(name, rule){
    if(typeOf(name) === "object"){
      for(var i in name){
        addRule(i,name[i])
      }
    }else{
      if(rules[name]) throw Error("addRule失败:已有相同规则名存在:"+name)
      rules[name] = rule
    }
    setup() //每次添加新规则后都重新组装一边
    return name //返回name
  },
  createAction = function(name){
    return function(all){
      alert("hahai")
      var current = this.current()
      current[name] = toArray(arguments)
    }
  },
  setupOneRule = function(rule,name,splits,curIndex){
    var retain = 0,
      regexp = rule.regexp,
      filter = rule.filter,
      retain = extractReg(regexp)+1 // 需要保留的参数
    links[curIndex] = [name,retain] //分别是rule名，参数数量
    curIndex += retain
    splits.push(regexp)
    if(!rule.action){
      rule.action = createAction(name)
    }
    if(filter && !filters[name]){
      filters[name] = rule.filter //将filter转移到filters下
    }
    return curIndex
  }
  // 组装
  // ------
  // 组装处理三件事:
  // 1. 生成symbol link 生成exec结果与action参数的对应
  // 2. 替换{}占位符，并生成Big Trunk
  // 3. 生成默认 action
  var setup = function(){
    var curIndex = 1, //当前下标
      splits = []
    cleanRules(rules)
    for(var i in rules){
      if(rules.hasOwnProperty(i)){// 这里把combo放置到最后
        curIndex = setupOneRule(rules[i], i,splits, curIndex)
      }
    }
    TRUNK = new RegExp("^(?:("+splits.join(")|(")+"))")
    cleanReg = new RegExp("\\s*(,|" + macros.combo + "|" + macros.operator + ")\\s*","g")
  }

  
  //    parse主逻辑
  // ----------------
  var 
    cleanReg,//这个在组装时候完成
    clean = function(sl){
      return sl.trim().replace(/\s+/g," ").replace(cleanReg,"$1")
    },
    // Process:处理每次匹配的函数
    // --------------------------
    // 1. 根据symbol link 散布参数
    process = function(){

      var parsed = this,
        args = slice.call(arguments),
        ruleName, link, rule, index
        for(var i in links){
          link = links[i]
          ruleName = link[0]
          retain =link[1]
          index = parseInt(i) 
          if(args[i] && (rule = rules[ruleName])){
            rule.action.apply(this,args.slice(index,index+retain))
          }
        }
      return ""
    },
    parseCache = createCache(200)

  var parse = function(sl){
    
    var selector = remain = clean(sl),parsed
    if(parsed = parseCache.get(selector)) return parsed

    var parsed = {},
      data = parsed.data = [[null]],
      part

    parsed.error = function(msg){
      throw Error("选择符\"" + sl + "含有味识别的选择器:Syntax Error")
    }
    parsed.current = function(){
      var piece = data[data.length-1],
        len = piece.length
      return piece[len-1] || (piece[len-1] = {tag:"*"})
    }
    while(remain != (remain = remain.replace(TRUNK,process.bind(parsed)))){
    }
    if(remain !== "") parsed.error()
    return parseCache.set(selector, parsed)
  }
  
  //   3. Finder
  // ================

  //   Util
  // -------------------------

  // 将nodelist转变为array
  
  //  DOM related Util
  // --------------------

  var
    root = doc.documentElement|| doc,
    attrMap = {
      'for': "htmlFor",
      'class': "className",
      "href":function(node){
        return "href" in node ? node.getAttribute("href",2):node.getAttribute("href")
      }
    },
  
    nthChild = function(node, n, type){
      var node = node.firstChild
      if(!node) return 
      if(type){
        if(node.nodeName === type) n--
      }else{
        if(node.nodeType === 1) n--
      }
      return nthNext(node,n, type)
    },
    nthLastChild =  function(node, n, type){
      var node = node.lastChild
      if(!node) return 
      if(type){
        if(node.nodeName === type) n--
      }else{
        if(node.nodeType === 1) n--
      }
      return nthPrev(node, n, type)
    },
    nthPrev = function(node, n, type){
      while(n && (node = node.previousSibling)){
        if(type){
          if(node.nodeName === type) n--
        }else{
          if(node.nodeType === 1) n--
        }
      }
      return node
    },
    // 向后查找n个节点元素
    nthNext =  function(node, n, type){
      while(n && (node = node.nextSibling)){
        if(type){
          if(node.nodeName === type) n--
        }else{
          if(node.nodeType === 1) n--
        }
      }
      return node
    },
    hasAttribute = testNode.hasAttribute? function(node,key){
      return node.hasAttribute(key)
    }:function(node,key){
      if (attrMap[key]) {
        return !!getAttribute(node,key) 
      }
      // MARK: ie下需要首先获取attributeNode fromm nwm 741行
      node = node.getAttributeNode(key) 
      return !!(node && (node.specified || node.nodeValue));
    },
    getAttribute = function(node,key){
      var map = attrMap[key]
      if(map) return typeof map ==="function" ? map(node):node[map]
      var value = node.getAttribute(key)
      return value ? 
        typeof node[key] === "boolean"?
          node[key] ? key : null 
          : value 
        : null
    },
    //数组去重
    distinct = function(array) {
      for (var i = array.length; i--;) {
        var n = array[i]
        // 先排除 即 如果它是清白的 后面就没有等值元素
        array.splice(i, 1, null) 
        if (~array.indexOf(n)) {
          array.splice(i, 1); //不清白
        } else {
          array.splice(i, 1, n); //不清白
        }
      }
      return array
    },
    // 从sly(修改自sizzle) 抄袭的 document sorter 
    // 将匹配元素集按文档顺序排列好 这很重要!
    sortor = (doc.compareDocumentPosition) ? function(a, b){
      if (!a.compareDocumentPosition || !b.compareDocumentPosition) return 0;
      return a.compareDocumentPosition(b) & 4 ? -1 : a === b ? 0 : 1;
    } : ('sourceIndex' in doc) ? function(a, b){
      if (!a.sourceIndex || !b.sourceIndex) return 0;
      return a.sourceIndex - b.sourceIndex;
    } : (doc.createRange) ? function(a, b){
      if (!a.ownerDocument || !b.ownerDocument) return 0;
      var aRange = a.ownerDocument.createRange(), bRange = b.ownerDocument.createRange();
      aRange.setStart(a, 0);
      aRange.setEnd(a, 0);
      bRange.setStart(b, 0);
      bRange.setEnd(b, 0);
      return aRange.compareBoundaryPoints(Range.START_TO_END, bRange);
    } : null,
    // 获得node的唯一标示
    getUid =(function(token){
      var _uid = 0 
      return function(node){
        return node._uid || (node._uid = token + _uid++)
      }
    })("nes_"+(+new Date).toString(36)),
    // 创建nth相关的Filter，由于都类似，就统一通过工厂函数生成了
    // 参数有两个  
    //    1. isNext: 代表遍历顺序是向前还是向后
    //    2. isType: 代表是否是要制定nodeName
    createNthFilter = function(isNext, isType){
      var next, prev, cache, getStart
      if(isNext){
        cache = nthPositionCache[""+(isType?"type":"child")]
        next = nthNext
        prev = nthPrev
        getStart = nthChild
      }else{
        cache = nthPositionCache["last"+(isType?"type":"child")]
        prev = nthNext
        next = nthPrev
        getStart = nthLastChild
      }

      
      return function (node, param){
        if(node === root) return false // 如果是html直接返回false 坑爹啊
        var _uid = getUid(node),
          parent = node.parentNode,
          traverse = param.step > 0? next : prev,
          step = param.step,
          start = param.start ,
          type = isType && node.nodeName
        //Fixed
        if(step === null) return false  //means always false
        if(!cache[_uid] && nes.usePositionCache){
          var startNode = getStart(parent,1, type),index = 0
          do{
            cache[getUid(startNode)] = ++index
            nthPositionCache.length++
          }while(startNode = next(startNode, 1, type))
        }else{
          position
        }
        var position = cache[_uid]
        if(step ===0) return position === start
        if((position - start)/step >= 0 && (position - start)%step == 0){
          return true
        }
      }
    },
    clearNthPositionCache = function(){
      if(nthPositionCache.length){
        nthPositionCache = {
          child:{},
          lastchild:{},
          type:{},
          lasttype:{},
          length:0
        }
      } 
    }
    window.nthPositionCache = {length:1}

    clearNthPositionCache()

  var 
    // 这里的几个finders是第一轮获取目标节点集的依赖方法
    // 我没有对byClassName做细致优化，比如用XPath的方式
    finders = {
      byId:function(id){
        var node = doc.getElementById(id)
        return node? [node] : [] 
      },
      byClassName:doc.getElementsByClassName?function(classList,node){
        classList == classList.join(" ")
        return toArray((node || doc).getElementsByClassName(classList))
      }:null,
      byTagName:function(tagName, node){
        var results = (node || doc).getElementsByTagName(tagName)
        return toArray(results)
      }
    },
    // ### filter: 
    // Action中塞入的数据会统一先这里处理，可能是直接处理如id、class等简单的.
    // 也可能是分发处理，甚至是多重的分发，如那些复杂的attribute或者是pesudo
    // 这里简化到过滤单个节点 逻辑清晰 ,但可能性能会降低，因为有些属性会重复获取
    filters = {
      id:function(node,id){
        return node.id === id
      },
      classList:function(node, classList){
        var len = classList.length,
         className = " "+node.className+" "

        for( ;len--; ){
          if(!~className.indexOf(" "+classList[len]+" ")){
            return false
          }
        }
        return true
      },
      tag:function(node, tag){
        if(tag == "*") return true
        return node.tagName.toLowerCase() === tag
      },
      // pesudos会分发到ExpandsFilter中pesudo中去处理
      pesudos:function(node, pesudos){
        var len = pesudos.length,
          pesudoFilters = expandFilters["pesudos"]

        for( ;len--; ){
          var pesudo = pesudos[len],
            name = pesudo.name,
            filter = pesudoFilters[name]

          if(!filter) throw Error("不支持的伪类:"+name)
          if(!filter(node, pesudo.param)) return false
        }
        return true
      },
      // attributes会分发到ExpandsFilter中的operator去处理
      attributes:function(node, attributes){
        var len = attributes.length,
          operatorFilters = expandFilters["operators"]

        for( ;len--; ){
          var attribute = attributes[len],
            operator = attribute["operator"],
            filter = operatorFilters[operator]

          if(!operator){
            if(!hasAttribute(node,attribute.key)){
              return false
            }
            continue
          }
          if(!filter) throw Error("不支持的操作符:"+operator)
          if(!filter(node, attribute.key, attribute.value)) return false
        }
        return true
      }
    },

    // expandFilters 
    // -------------------------
    // 原生可扩展的方法
    expandFilters = {
        // __扩展连接符__:
        // 选择符filter 与其他filter不同 node 同样是当前节点 区别是
        // 如果成功返回成功的上游节点(可能是父节点 可能是兄弟节点等等)
        // 其中 match(node) 返回 这个上游节点是否匹配剩余选择符(内部仍是一个递归)
      combos: {
        ">": function(node,match){
          var parent = node.parentNode
          if(match(parent)) return parent
        },
        "~": function(node,match){
          var prev = nthPrev(node,1)
          while(prev){
            if(match(prev)) return prev
            prev = nthPrev(prev, 1)
          }
        },
        " ":function(node,match){
          var parent = node.parentNode
          while(parent){
            var pass = match(parent)
            if(pass) return parent
            if(pass === null) return null
            parent = parent.parentNode
          }
          return null
        },
        "+":function(node,match){
          var prev = nthPrev(node, 1)
          if(prev && match(prev)) return prev
        }
      },
      // __扩展操作符__ :
      operators: {
        "^=":function(node, key , value){
          var nodeValue = getAttribute(node, key)
          if(nodeValue == null) return false
          return nodeValue.indexOf(value) === 0
        },
        "=":function(node, key, value){
          return getAttribute(node,key) == value
        },
        "~=":function(node, key, value){
          var nodeValue = getAttribute(node, key)
          if(nodeValue == null) return false

          var values = nodeValue.split(/\s+/),
            len=values.length

          for(;len--;){
            if(values[len] == value) return true
          }
          return false
        },
        "$=":function(node, key, value){
          var realValue = getAttribute(node, key)
          return value && typeof realValue == "string" && realValue.substr(realValue.length - value.length) === value
        },
        "|=":function(node, key, value){
          var realValue = getAttribute(node,key)||""
          return ~("-"+realValue+"-").indexOf("-"+value+"-")
        },
        "*=":function(node,key,value){
          return ~(getAttribute(node,key) || " ").indexOf(value)
        },
        "!=":function(node,key,value){
          return getAttribute(node, key) !== value
        }
      },
      // __扩展伪类__:
      pesudos: {
        //TODO:这里如果出自 SELECtorAPI 标注下处处
        "not":function(node, sl){
          return !matches(node, sl)
        },
        "matches":function(node, sl){
          return matches(node, sl)
        },
        // child pesudo
        "nth-child":createNthFilter(1,0),
        "nth-last-child":createNthFilter(0,0),
        "nth-of-type":createNthFilter(1,1),
        "nth-last-of-type":createNthFilter(0,1),
        "nth-match":function(node,param){
          var 
            tmp = param.split(/\s+of\s+/),
            nth = parseInt(tmp[0]),
            sl = tmp[1],
            start = node.parentNode.firstChild

          do{
            if(start.nodeType === 1 && nes.matches(start , sl)) nth--
          }while(nth&&(start = start.nextSibling))

          return !nth && node === start 
        },
        "first-child":function(node){
          return !nthPrev(node, 1)
        },
        "last-child":function(node){
          return !nthNext(node, 1)
        },
        "last-of-type":function(node){
          return !nthNext(node, 1, node.nodeName)
        },
        "first-of-type":function(node){
          return !nthPrev(node, 1, node.nodeName)
        },
        "only-child":function(node){
          return !nthPrev(node,1) && !nthNext(node,1)
        },
        "only-of-type":function(node){
          return !nthPrev(node, 1, node.nodeName) && !nthNext(node, 1, node.nodeName)
        },
        "checked":function(node){
          return !!node.checked || !!node.selected
        },
        "selected":function(node){
          return node.selected
        },
        "enabled":function(node){
          return node.disabled === false 
        },
        "disabled":function(node){
          return node.disabled === true
        },
        "empty":function(node){
          var nodeType;
          node = node.firstChild;
          while ( node ) {
            if ( node.nodeName > "@" || (nodeType = node.nodeType) === 3 || nodeType === 4 ) {
              return false;
            }
            node = node.nextSibling;
          }
          return true;
        },
        "focus":function(node){
          return node === doc.activeElement && (!doc.hasFocus || doc.hasFocus()) && !!(node.type || node.href || ~node.tabIndex);
        },
        "target":function(node,param){
          var id = node.id || node.name
          if(!id) return false
          return ("#"+id) ===  location.hash
        }
      }
    },
    // 这里主要是整合之前的ExpandsFilter中的mathch, 单层数据
    matchDatum = function(node, datum, ignored){
      var subFilter
      for(var i in datum){
        if(ignored !==i && (subFilter = filters[i]) && !subFilter(node,datum[i])){
          return false
        }
      }
      return true
    },
    // 这个全局cache的引入是为了避免多次传入参数。
    // 当然全局的缺点也很明显，维护会不方便, 不利于测试
    matchesCache = null,//保存那些matches函数
    matchData = function(node, data ,ignored){ // 稍后再看存入step
      var len = data.length,
        datum = data[len-1]
      // 首先要满足自身
      if(!matchDatum(node,datum,ignored)) return false
      else{
        if(len == 1) return true
        var
          nextDatum = data[len-2],
          getNext = expandFilters.combos[nextDatum.combo],
          match = matchesCache[len-2],
          next = getNext(node,match)

        if(next) return true
        else return false
      }
    },
    //动态产生供FilterOneNode使用的match
    createMatch = function(data){
      return function(node){
        if(node == root|| node == null) return null //null 相当于休止符
        return matchData(node, data)
      }
    },
    createMatches = function(data){
      var matches = []
      for(var i = 0, len = data.length; i < len ; i++){
        matches.push(createMatch(data.slice(0,i+1)))
      }
      return matches
    },
    // 过滤主函数filter
    // -----------------------------------
    // 自底向上过滤非匹配节点
    filter = function(results,data,ignored){
      if(!data.length) return results  
      //这里是为了缓存match匹配函数
      var preMatchesCache = matchesCache
      matchesCache = createMatches(data)
      for(var i=results.length; i--; ){
        if(!matchData(results[i],data,ignored)){
          results.splice(i,1)
        }
      }
      // Fixed: 因为一次filter可能会有字filter调用，比如matches、not、include
      matchesCache = preMatchesCache  // warning :以后写全局变量一定当心
      return results
    },
    // 获得第一次目标节点集
    getTargets = function(data, context){
      var results,ignored ,lastPiece = data[data.length-1]
      if(lastPiece.id){ 
        results = finders.byId(lastPiece.id) 
        ignored = "id"
      }else if(lastPiece.classList && lastPiece.classList.length && finders.byClassName){
        results = finders.byClassName(lastPiece.classList, context)
        ignored = "classList"
      }else{
        results = finders.byTagName(lastPiece.tag||"*", context)
        ignored = "tag"
      }
      if(!results.length) return results
      return filter(results,data,ignored)
    }
  // API 3 : find (private)
  // -------------
  // 根据parse后的数据进行节点查找
  // options:
  //    1. parsed.data  parse数据为一数组
  //    2. node         context节点
  // 事实上没有data这个单词，我这里算是自定了这个单词
  //     datas : [data,data]   
  //     data : [datum, datum]
  //     datum: {tag:"*"....etc}
 
  var find =function(datas, context){
    var results = []
    for(var i = 0, len = datas.length ;i<len; i++){
      var data = datas[i],dlen = data.length,
        last = data[dlen-1]
      results = results.concat(getTargets(data, context))
    }
    if(!results.length) return results
    if(len>1) distinct(results)
    results.sort(sortor) 
    clearNthPositionCache()
    return results
  } 
  // API 4: 测试用get相当于all (private)
  // -------------------------------------
  // 为了测试时避免原生querySelector的影响
  // 
  var get = function(sl, context){
    var data = parse(sl).data
    var result =  find(data, context||doc)

    return result
  }

  // API 
  // ----------------------------------------------------------------------
  var supportQuerySelector = !!doc.querySelector

  var one = function(sl, context){
    var node
    if(supportQuerySelector){
      try{
        node = (context||doc).querySelector(sl)
      }catch(e){
        node = get(sl,context)[0]
      }
    }else{
        node = get(sl,context)[0]
    }
    return node
  }

  var all = function(sl, context){
    var nodeList
    if(supportQuerySelector){
      try{
        nodeList = (context||doc).querySelectorAll(sl)
      }catch(e){
        nodeList = get(sl,context)
      }
    }else{
        nodeList = get(sl,context)
    }
    return nodeList
  }

  // matches 单步调用方法
  var matchOneData = function(node,data){
    var len = data.length
    if(!matchDatum(node, data[len-1])){
      return false
    }else{
      return filter([node],data.slice(0,-1)).length ===1
    }
  }
  // API 5: selector api 2 matches (public)
  // ----------------------------------------------------------------------
  // nes的matches支持用分隔符链接符组合的复杂选择器
  // 即与all、one函数的支持是一样的
  // 由于:not与:matches依赖于这个函数 ,所以同样支持复杂选择器
  var matches = function(node,sl){
    var datas = parse(sl).data,
      len = datas.length
    for( ;len--; ){
      if(matchOneData(node,datas[len])) return true
    }
    return false
  } 
  

  //      Creator 开始
  // ----------------------
  var createNode = function(option){
    var tag = option.tag,
      node = doc.createElement(tag == "*"? "div":option.tag),
      creater
    for(var i in option){
      if(creater = ExpandCreater[i]){
        creater(node, option[i])
      }
    }
    return node
  }
  var ExpandCreater = {
    id:function(node, id){
      node.id = id
    },
    classList: function(node, classList){
      node.className = classList.join(" ")
    },
    attributes:function(node, attributes){
      var len = attributes.length, attribute
      for(;len--;){
        attribute = attributes[len]
        node.setAttribute(attribute.key, typeof attribute.value == "undefined"? true : attribute.value)
      }
    }
  }
  // API 6: 按Simple Selector生成dom节点
  // __注意只支持单节点__ :即
  // 如:nes.create("p#id.class1.class2")
  var create = function(sl){
    var data = parse(sl).data[0],
      len = data.length,
      datum, parent, current, prev
    for(var i = 0; i < len; i++){
      datum = data[i]
      if(i !== len-1 && datum.combo !== ">") throw Error("节点创建不能传入非>连接符")
      prev = current
      current = createNode(datum)
      if(!parent){ parent = current}
      if(prev) prev.appendChild(current)
    }
    return parent
  }
  
  // ASSEMBLE
  // ----------------

  setup()                     // 动态组装parser
  // 生成pesudo 、 operator、combo 等expand方法
  // ----------------------------------------------------------------------
  ;(function createExpand(host,beforeAssign){
    for(var i in host){
      nes[i] = (function(i){
        var container = host[i]
        return autoSet(function(key, value){
          if(!container[key]){
            container[key] = value
            if(i in beforeAssign){
              beforeAssign[i](key,value)
            }
          }
        })
      })(i)
    }
  })(expandFilters,{
    "operators": function(key){
      var befores= macros.operator.split("]")
      befores.splice(1,0,key.charAt(0)+"]")
      macros.operator = befores.join("")
      setup()
    },
    "combos": function(key){
      var befores= macros.combo.split("]")
      befores.splice(1,0,key+"]")
      macros.combo = befores.join("")
      setup()
    }
  })


  //5.Wrapper 类
  //使用
  // nes("ul.test1").parent("div")

  var NES = function(sl,context){
    var type = typeOf(sl)
    if(type ==="string"){
      this.elements = nes.all(sl, context)
    }else if(sl.nodeType ===1){
      this.elements = [sl]
    }else{
      this.elements = toArray(sl)
    }
    if(!this.elements.length) throw Error("未找到所要包装的节点")
  }
  extend(NES.prototype, {
    eq:function(i){
      return this.elements[i]
    },
    one:function(sl){
      var first = this.elements[0]
      return sl? nes.one(sl, first) : first
    },
    all:function(sl){
      return sl? nes.all(sl, this.elements[0]) : this.elements
    },
    filter:function(sl){
      return filter(toArray(this.elements), parse(sl).data[0])
    },
    parent:function(sl){
      var first = this.elements[0],
        parent = first.parentNode

      while(parent&&parent!==doc){
        if(!sl || matches(parent, sl)) return parent
        parent = parent.parentNode
      }
      return null
    },
    next:function(sl){
      var first = this.elements[0],
        next = nthNext(first, 1)

      while(next){
        if(!sl || matches(next, sl)) return next
        next = nthNext(next, 1)
      }
      return null
    },
    prev:function(sl){
      var first = this.elements[0],
        prev = nthPrev(first, 1)

      while(prev){
        if(!sl || matches(prev, sl)) return prev
        prev = nthPrev(prev, 1)
      }
      return null
    }
  })

  extend(nes,{
    // setting stuff 设置它们的length控制缓存
    nthCache: nthCache,
    parseCache :parseCache,
    // 是否用节点缓存节点位置,默认true
    usePositionCache: true,

    // 测试接口
    parse: parse, //解析
    find: find,   //查找
    _get: get,     //测试时排除原生querySelector的影响

    //        *主要API*
    // -------------------------
    one:one,
    all:all,
    matches:matches,
    create:create,
    not: function(node, sl){return !matches(node,sl)},
    // 内建扩展 api

    // pesudos:pesudos, 这三个已经内建
    // operators:operators
    // combos:combos

    // 规则扩展API
    addRule:addRule,
    fn: NES.prototype
    // 
  })

  //          5.Exports
  // ----------------------------------------------------------------------
  // 暴露API:  amd || commonjs || NEJ define || global 
  // 支持commonjs
  if (typeof exports === 'object') {
    module.exports = nes
    // 支持amd
  } else if (typeof define === 'function' && define.amd) {
    define(function() {
      return nes
    })
  }else {
    // 直接暴露到全局
    win.nes = nes
    nes.noConflict = function(name){
      win[name] = nes
      win.nes = prevNes
    }
  }

}(window,document)
  // TODO: 内容
  // 1. 重构 √
  // 2. 自定义ruler 并setup  √
  // 3. nthChild方法的重构 直接从childNodes中进行判断而不是同级游走 X 测试结果排除
  // 4. 准备{a,b}(类似regexp的例子) √
  // 5. 准备好pesudo(incude?) attr combo的例子 √
  // 6. try cache 捕获未被系统识别的selector √
  // 7. 准备好delegate Event的例子 √
  // 9. Wrapper扩展接口  
  // 10.nwmatcher提到几个兼容性处理 
  // 11.调用combo、operator时候动态将规则写进macro中并setup √
  // 12.将combo的优先级降到最低 (因为单字符更容易被匹配到) X 暂时不做
  // 13.完成nth的优化
  // 14. 做好find的demo 、做好Wrapper类 构思好如何扩展
  // 
  // 
// HAHAHA

