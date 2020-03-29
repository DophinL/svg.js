import { nodeOrNew, register, wrapWithAttrCheck } from '../utils/adopter.js'
import { registerMethods } from '../utils/methods.js'
import { xlink } from '../modules/core/namespaces.js'
import Container from './Container.js'

export default class A extends Container {
  constructor (node, attrs = node) {
    super(nodeOrNew('a', node), attrs)
  }

  // Link url
  to (url) {
    return this.attr('href', url, xlink)
  }

  // Link target attribute
  target (target) {
    return this.attr('target', target)
  }
}

registerMethods({
  Container: {
    // Create a hyperlink element
    link: wrapWithAttrCheck(function (url) {
      return this.put(new A()).to(url)
    })
  },
  Element: {
    unlink () {
      var link = this.linker()

      if (!link) return this

      var parent = link.parent()

      if (!parent) {
        return this.remove()
      }

      var index = parent.index(link)
      parent.add(this, index)

      link.remove()
      return this
    },
    linkTo (url) {
      // reuse old link if possible
      var link = this.linker()

      if (!link) {
        link = new A()
        this.wrap(link)
      }

      if (typeof url === 'function') {
        url.call(link, link)
      } else {
        link.to(url)
      }

      return this
    },
    linker () {
      var link = this.parent()
      if (link && link.node.nodeName.toLowerCase() === 'a') {
        return link
      }

      return null
    }
  }
})

register(A, 'A')
