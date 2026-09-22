const MINUTES_PER_HOUR = 60
const MINUTE_ROUNDS = 5
const MIDDLE_ROUND_START = MINUTES_PER_HOUR * 2
const SETTLE_DELAY_MS = 50

const pad = value => String(value).padStart(2, '0')

function initialIndices(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '')
  const hour = match ? Number(match[1]) : 0
  const minute = match ? Number(match[2]) : 0
  if (hour > 23 || minute > 59) return [0, MIDDLE_ROUND_START]
  return [hour, MIDDLE_ROUND_START + minute]
}

function sameIndices(left, right) {
  return left && right && left[0] === right[0] && left[1] === right[1]
}

Component({
  properties: {
    value: {
      type: String,
      value: '00:00'
    }
  },

  data: {
    hours: Array.from({ length: 24 }, (_, hour) => pad(hour)),
    minutes: Array.from({ length: MINUTES_PER_HOUR * MINUTE_ROUNDS }, (_, index) => ({
      id: index,
      label: pad(index % MINUTES_PER_HOUR)
    })),
    pickerValue: [0, MIDDLE_ROUND_START],
    busy: false
  },

  lifetimes: {
    attached() {
      this._attached = true
      this._closing = false
      this._picking = false
      this._settling = false
      this._interactionVersion = 0
      this._settleTimer = null
      this._recenterTarget = null
      // Read once: a parent clock refresh must not overwrite an open draft.
      this._indices = initialIndices(this.properties.value)
      this.setData({ pickerValue: this._indices.slice(), busy: false })
    },

    detached() {
      this._attached = false
      this._interactionVersion += 1
      this._clearSettleTimer()
    }
  },

  methods: {
    preventTouchMove() {},

    onPickStart() {
      if (!this._attached || this._closing) return
      this._interactionVersion += 1
      this._clearSettleTimer()
      this._picking = true
      this._settling = true
      this._recenterTarget = null
      this.setData({ busy: true })
    },

    onPickEnd() {
      if (!this._attached || this._closing) return
      this._interactionVersion += 1
      this._picking = false
      this._scheduleSettle()
    },

    onChange(event) {
      if (!this._attached || this._closing) return
      const next = event.detail && event.detail.value
      if (!Array.isArray(next) || next.length !== 2 ||
          !Number.isInteger(next[0]) || next[0] < 0 || next[0] > 23 ||
          !Number.isInteger(next[1]) || next[1] < 0 ||
          next[1] >= MINUTES_PER_HOUR * MINUTE_ROUNDS) return

      // Some clients emit change after a programmatic value update. Its
      // displayed time is already committed, so do not start another recenter.
      if (!this._picking && sameIndices(next, this._recenterTarget)) {
        this._recenterTarget = null
        return
      }

      this._interactionVersion += 1
      this._indices = next.slice()
      this._settling = true
      this.setData({ busy: true })
      if (!this._picking) this._scheduleSettle()
    },

    _clearSettleTimer() {
      if (this._settleTimer !== null) {
        clearTimeout(this._settleTimer)
        this._settleTimer = null
      }
    },

    _scheduleSettle() {
      this._clearSettleTimer()
      this._settling = true
      this.setData({ busy: true })
      const version = this._interactionVersion
      // change and pickend arrive in different orders across clients. Wait
      // briefly after the latest event before enabling confirmation.
      this._settleTimer = setTimeout(() => {
        this._settleTimer = null
        if (!this._attached || this._picking || version !== this._interactionVersion) return

        const next = this._indices.slice()
        if (next[1] < MINUTES_PER_HOUR || next[1] >= MINUTES_PER_HOUR * (MINUTE_ROUNDS - 1)) {
          // Recenter only in an outer round, after scrolling has stopped.
          // Modulo changes the minute column alone; it never carries an hour.
          next[1] = MIDDLE_ROUND_START + next[1] % MINUTES_PER_HOUR
          this._recenterTarget = next.slice()
        }
        this._indices = next
        this.setData({ pickerValue: next.slice() }, () => {
          if (!this._attached || this._picking || version !== this._interactionVersion) return
          this._settling = false
          this.setData({ busy: false })
        })
      }, SETTLE_DELAY_MS)
    },

    onConfirm() {
      if (!this._attached || this._closing || this._picking || this._settling || this.data.busy) return
      const [hour, minuteIndex] = this._indices
      this.triggerEvent('confirm', {
        value: `${pad(hour)}:${pad(minuteIndex % MINUTES_PER_HOUR)}`
      })
    },

    onCancel() {
      if (!this._attached || this._closing) return
      this._closing = true
      this._interactionVersion += 1
      this._clearSettleTimer()
      this.triggerEvent('cancel')
    }
  }
})
