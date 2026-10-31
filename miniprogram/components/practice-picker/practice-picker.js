function optionHint(option) {
  if (option.type === 'all') return '包含已隐藏功课的历史记录'
  if (option.type === 'kindness') return '善行记录'
  if (option.unit === '分钟') return '按分钟'
  if (option.unit === '次') return '按次数'
  if (option.unit === '件') return '按件数'
  return option.unit ? `按${option.unit}记录` : '功课记录'
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    options: { type: Array, value: [] },
    selectedType: { type: String, value: '' },
    title: { type: String, value: '选择功课' },
    subtitle: { type: String, value: '' }
  },

  data: {
    displayOptions: [],
    hasPracticeOptions: false,
    listHeight: 200
  },

  observers: {
    options(options) {
      const seen = new Set()
      const normalizedOptions = (Array.isArray(options) ? options : [])
        .filter(option => {
          if (!option || typeof option.type !== 'string' || !option.type || seen.has(option.type)) return false
          seen.add(option.type)
          return true
        })
        .map(option => ({
          type: option.type,
          name: option.name || '功课',
          hint: optionHint(option)
        }))
      const displayOptions = normalizedOptions.filter(option => option.type === 'all')
        .concat(normalizedOptions.filter(option => option.type !== 'all'))
      const practiceCount = displayOptions.filter(option => option.type !== 'all').length
      const allCount = displayOptions.length - practiceCount
      const rows = Math.ceil(practiceCount / 2) + allCount
      this.setData({
        displayOptions,
        hasPracticeOptions: practiceCount > 0,
        listHeight: rows * 132 + Math.max(0, rows - 1) * 16 + (practiceCount ? 0 : 200)
      })
    }
  },

  methods: {
    preventTouchMove() {},

    onSelect(event) {
      if (!this.properties.visible) return
      const type = event.currentTarget.dataset.type
      if (!this.data.displayOptions.some(option => option.type === type)) return
      this.triggerEvent('select', { type })
    },

    onClose() {
      if (this.properties.visible) this.triggerEvent('close', {})
    },

    onSettings() {
      if (this.properties.visible) this.triggerEvent('settings', {})
    }
  }
})
