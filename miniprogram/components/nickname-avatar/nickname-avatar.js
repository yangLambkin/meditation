const { getAvatarInitial, getAvatarSource } = require('../../utils/avatar.js');

Component({
  options: { virtualHost: true },
  externalClasses: ['avatar-class'],
  properties: {
    src: { type: String, value: '' },
    nickname: { type: String, value: '' },
    size: { type: Number, value: 76 }
  },
  data: { imageSource: '', initial: '友' },
  observers: {
    src(source) {
      this.setData({ imageSource: getAvatarSource(source) });
    },
    nickname(name) {
      this.setData({ initial: getAvatarInitial(name) });
    }
  },
  methods: {
    onImageError() {
      this.setData({ imageSource: '' });
    }
  }
});
